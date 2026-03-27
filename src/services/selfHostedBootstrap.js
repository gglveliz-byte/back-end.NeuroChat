// ─── Self-Hosted AI Bootstrap ─────────────────────────────────────────
// Monkey-patches the OpenAI constructor at startup to route all
// chat.completions.create() calls through the self-hosted vLLM server first.
// If self-hosted fails, falls back transparently to the original OpenAI client.
//
// Load this ONCE in app.js: require('./services/selfHostedBootstrap');
// Must run AFTER dotenv.config() and BEFORE any service imports.

const selfHostedAI = require('./selfHostedAIService');
const aiMetrics = require('./aiMetricsService');

// ─── Mode management ─────────────────────────────────────────────────
let currentMode = process.env.AI_PROVIDER_MODE || 'external';
let lastModeRefresh = Date.now();
const MODE_REFRESH_INTERVAL = 60000; // refresh from DB every 60s

async function refreshModeFromDB() {
  try {
    const { query } = require('../config/database');
    const result = await query("SELECT value FROM system_config WHERE key = 'ai_provider_mode'");
    if (result.rows[0]) {
      const newMode = JSON.parse(result.rows[0].value);
      if (newMode !== currentMode) {
        console.log(`[SelfHosted Bootstrap] Mode changed: ${currentMode} → ${newMode}`);
        currentMode = newMode;
        // Update chunk optimization flag
        process.env._SELF_HOSTED_CHUNK_OPTIMIZATION = (newMode === 'self-hosted' || newMode === 'auto') ? 'true' : '';
      }
    }
  } catch {
    // DB not ready yet or query failed — keep current mode
  }
  lastModeRefresh = Date.now();
}

function getCurrentMode() {
  // Lazy refresh from DB
  if (Date.now() - lastModeRefresh > MODE_REFRESH_INTERVAL) {
    refreshModeFromDB().catch(() => {});
    // Don't await — use stale value this time, fresh next time
  }
  return currentMode;
}

// Allow external code to update mode immediately (e.g., admin toggle)
function setMode(newMode) {
  console.log(`[SelfHosted Bootstrap] Mode set: ${currentMode} → ${newMode}`);
  currentMode = newMode;
  process.env._SELF_HOSTED_CHUNK_OPTIMIZATION = (newMode === 'self-hosted' || newMode === 'auto') ? 'true' : '';
}

// ─── Detect call type for metrics ────────────────────────────────────
function detectServiceType(params) {
  const systemMsg = params.messages?.[0]?.content || '';
  const maxTokens = params.max_tokens || 500;
  const isJson = params.response_format?.type === 'json_object';

  // B2B auditor: JSON mode + high tokens + quality prompt markers
  if (isJson && maxTokens >= 4000) return 'b2b-auditor';
  // B2B filter: JSON mode + classification patterns
  if (isJson && systemMsg.includes('clasificación')) return 'b2b-filter';
  // B2B webchat: tools with check_coverage/submit_lead
  if (params.tools?.some(t => t.function?.name === 'check_coverage' || t.function?.name === 'submit_lead')) return 'b2b-webchat';
  // Voice: very short max_tokens
  if (maxTokens <= 200) return 'voice';
  // Default: B2C chat
  return 'b2c-chat';
}

// ─── The core proxy logic ────────────────────────────────────────────
async function proxiedChatCompletion(originalCreateFn, originalThis, params) {
  const mode = getCurrentMode();

  // Mode: external → bypass completely (zero overhead)
  if (mode === 'external') {
    return originalCreateFn.call(originalThis, params);
  }

  // Self-hosted not configured → bypass
  if (!selfHostedAI.isConfigured()) {
    return originalCreateFn.call(originalThis, params);
  }

  // Circuit breaker open → bypass to original
  if (selfHostedAI.isCircuitOpen()) {
    console.warn(`[SelfHosted Bootstrap] Circuit breaker OPEN — bypassing self-hosted for ${detectServiceType(params)}`);
    const start = Date.now();
    const result = await originalCreateFn.call(originalThis, params);
    aiMetrics.record({
      provider: 'openai',
      service: detectServiceType(params),
      latencyMs: Date.now() - start,
      success: true,
      fallback: true,
      reason: 'circuit-breaker-open',
      inputTokens: result.usage?.prompt_tokens || 0,
      outputTokens: result.usage?.completion_tokens || 0,
    });
    return result;
  }

  const start = Date.now();
  const serviceType = detectServiceType(params);

  try {
    const result = await selfHostedAI.chatCompletionStream(params);
    const latencyMs = Date.now() - start;

    selfHostedAI.recordSuccess();
    aiMetrics.record({
      provider: 'self-hosted',
      service: serviceType,
      latencyMs,
      success: true,
      fallback: false,
      inputTokens: result.usage?.prompt_tokens || 0,
      outputTokens: result.usage?.completion_tokens || 0,
    });

    return result;
  } catch (selfHostedError) {
    const selfHostedLatency = Date.now() - start;

    // ── Classify the error ────────────────────────────────────────────
    // TIMEOUT = server is still processing the request (not broken).
    // Do NOT fall back to OpenAI — that would waste resources and fail with 401
    // if no valid key is configured. Let the caller/queue retry after a delay.
    const isTimeout =
      selfHostedError.code === 'ETIMEDOUT' ||
      selfHostedError.code === 'ECONNABORTED' ||
      (selfHostedError.message && selfHostedError.message.toLowerCase().includes('timeout'));

    const isClientError =
      selfHostedError.response &&
      selfHostedError.response.status >= 400 &&
      selfHostedError.response.status < 500;

    // Only count as circuit-breaker failure for real server/network errors.
    // Timeouts don't mean the server is broken — it's still working.
    if (!isClientError && !isTimeout) {
      selfHostedAI.recordFailure();
    }

    const errorType = isTimeout ? 'TIMEOUT(servidor procesando)' : isClientError ? 'CLIENT_ERROR' : 'SERVER_ERROR';
    console.warn(`[SelfHosted Bootstrap] Self-hosted failed (${selfHostedLatency}ms) [${errorType}]: ${selfHostedError.message} — service: ${serviceType}`);

    // ── TIMEOUT: server is processing — do NOT call OpenAI ───────────
    if (isTimeout) {
      aiMetrics.record({
        provider: 'self-hosted',
        service: serviceType,
        latencyMs: selfHostedLatency,
        success: false,
        fallback: false,
        reason: 'timeout-servidor-procesando',
      });
      const timeoutErr = new Error(
        `[AI_TIMEOUT] El servidor IA superó el tiempo máximo (${Math.round(selfHostedLatency / 1000)}s). ` +
        `Reintenta en unos segundos.`
      );
      timeoutErr.code = 'AI_TIMEOUT';
      throw timeoutErr;
    }

    // ── REAL ERROR: server down / 5xx — attempt OpenAI fallback ──────
    try {
      const fallbackStart = Date.now();
      const result = await originalCreateFn.call(originalThis, params);
      aiMetrics.record({
        provider: 'openai',
        service: serviceType,
        latencyMs: Date.now() - fallbackStart,
        success: true,
        fallback: true,
        reason: selfHostedError.message?.substring(0, 100),
        inputTokens: result.usage?.prompt_tokens || 0,
        outputTokens: result.usage?.completion_tokens || 0,
      });
      return result;
    } catch (fallbackError) {
      aiMetrics.record({
        provider: 'openai',
        service: serviceType,
        latencyMs: Date.now() - start,
        success: false,
        fallback: true,
        reason: fallbackError.message?.substring(0, 100),
      });

      // If OpenAI fails with 401 (no valid key configured) — throw a clean error
      // instead of propagating the confusing "Incorrect API key" message.
      const isFallbackAuth =
        fallbackError.status === 401 ||
        (fallbackError.message && fallbackError.message.includes('401'));

      if (isFallbackAuth) {
        const cleanErr = new Error(
          `[AI_SERVICE_UNAVAILABLE] Servidor IA no disponible. Error original: ${selfHostedError.message}`
        );
        cleanErr.code = 'AI_SERVICE_UNAVAILABLE';
        throw cleanErr;
      }

      throw fallbackError; // other OpenAI error — propagate normally
    }
  }
}

// ─── Patch the OpenAI module ─────────────────────────────────────────
function patchOpenAI() {
  try {
    const openaiModulePath = require.resolve('openai');
    const openaiModule = require(openaiModulePath);

    // Save reference to the real OpenAI class
    const RealOpenAI = openaiModule.default || openaiModule.OpenAI || openaiModule;

    if (!RealOpenAI || typeof RealOpenAI !== 'function') {
      console.warn('[SelfHosted Bootstrap] Could not find OpenAI constructor — skipping patch');
      return;
    }

    // Create a wrapper class
    class ProxiedOpenAI extends RealOpenAI {
      constructor(...args) {
        super(...args);

        // Store reference to the real completions.create
        const realChat = this.chat;
        const realCompletions = realChat?.completions;
        if (!realCompletions?.create) return;

        const originalCreate = realCompletions.create.bind(realCompletions);

        // Override chat.completions.create with our proxy
        realCompletions.create = async (params) => {
          return proxiedChatCompletion(originalCreate, realCompletions, params);
        };
      }
    }

    // Replace in module cache
    const cacheKey = openaiModulePath;
    if (require.cache[cacheKey]) {
      const mod = require.cache[cacheKey];

      // Copy all named exports (APIError, etc.) onto ProxiedOpenAI, then replace .OpenAI/.default
      Object.keys(mod.exports).forEach(key => {
        try {
          ProxiedOpenAI[key] = (key === 'OpenAI' || key === 'default')
            ? ProxiedOpenAI
            : mod.exports[key];
        } catch {}
      });

      // Replace mod.exports itself so `const OpenAI = require('openai')` gets ProxiedOpenAI
      // This fixes services that import the whole module (not destructured {OpenAI})
      mod.exports = ProxiedOpenAI;
    }

    // Initial mode setup
    const mode = process.env.AI_PROVIDER_MODE || 'external';
    process.env._SELF_HOSTED_CHUNK_OPTIMIZATION = (mode === 'self-hosted' || mode === 'auto') ? 'true' : '';

    const configured = selfHostedAI.isConfigured();
    console.log(`[SelfHosted Bootstrap] Initialized — mode: ${mode}, server configured: ${configured}`);

    if (configured && mode !== 'external') {
      // Run initial health check in background
      selfHostedAI.healthCheck().then(status => {
        console.log(`[SelfHosted Bootstrap] Server health: ${status.healthy ? 'OK' : 'UNREACHABLE'} (${status.latencyMs}ms)`);
      }).catch(() => {
        console.warn('[SelfHosted Bootstrap] Initial health check failed');
      });
    }
  } catch (error) {
    // If patching fails, the system continues to work normally with OpenAI
    console.error(`[SelfHosted Bootstrap] Failed to patch OpenAI module: ${error.message}`);
    console.error('[SelfHosted Bootstrap] System will continue with external providers only');
  }
}

// ─── Patch for axios-based clients (Gemini in b2bAgentService) ───────
// The Gemini provider in b2bAgentService uses axios directly, not OpenAI SDK.
// We don't intercept Gemini — it stays as-is. Only OpenAI calls are proxied.

// ─── Execute patch on require ────────────────────────────────────────
patchOpenAI();

// ─── Export for admin controller ─────────────────────────────────────
module.exports = {
  getCurrentMode,
  setMode,
  refreshModeFromDB,
};
