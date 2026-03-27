const axios = require('axios');

// ─── Self-Hosted AI Service (vLLM / Qwen2.5-72B) ─────────────────────
// Direct client to the self-hosted vLLM server.
// Provides: health check, chat completion, embeddings, circuit breaker.
// Does NOT depend on the OpenAI SDK — uses axios for raw HTTP calls.

const SELF_HOSTED_API_URL = process.env.SELF_HOSTED_API_URL || '';
const SELF_HOSTED_API_KEY = process.env.SELF_HOSTED_API_KEY || '';
const SELF_HOSTED_MODEL = process.env.SELF_HOSTED_MODEL || 'Qwen2.5-72B-Instruct-GPTQ-Int4';
const SELF_HOSTED_EMBEDDING_URL = process.env.SELF_HOSTED_EMBEDDING_URL || '';
const SELF_HOSTED_EMBEDDING_MODEL = process.env.SELF_HOSTED_EMBEDDING_MODEL || 'gte-Qwen2-1.5B-instruct';

// ─── Timeouts ────────────────────────────────────────────────────────
// Timeouts configurable via .env — set higher if your server needs more time.
// SELF_HOSTED_TIMEOUT_CHAT_MS   — for chat/filter/webchat requests (default 5 min)
// SELF_HOSTED_TIMEOUT_ANALYSIS_MS — for B2B analysis with large JSON output (default 15 min)
const TIMEOUT_CHAT_MS = parseInt(process.env.SELF_HOSTED_TIMEOUT_CHAT_MS || '300000', 10);
const TIMEOUT_ANALYSIS_MS = parseInt(process.env.SELF_HOSTED_TIMEOUT_ANALYSIS_MS || '900000', 10);

// ─── Retry ───────────────────────────────────────────────────────────
const RETRY_MAX = 2;          // up to 2 retries = 3 total attempts
const RETRY_BASE_MS = 500;    // 500ms → 1000ms (exponential backoff)

// Errors worth retrying (transient network failures only).
// ETIMEDOUT / ECONNABORTED are intentionally excluded: a timeout means the server is
// still processing the previous request — sending another request immediately would
// overload the server. Let the caller (bootstrap) handle timeouts instead.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'ENETUNREACH', 'ECONNREFUSED']);

function isRetryable(error) {
  if (RETRYABLE_CODES.has(error.code)) return true;
  if (error.response) {
    const status = error.response.status;
    return status === 429 || status === 502 || status === 503 || status === 504;
  }
  return false;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Circuit Breaker ─────────────────────────────────────────────────
const BREAKER_THRESHOLD = 3;    // consecutive failures to trip
const BREAKER_COOLDOWN_MS = 60000; // 60s cooldown before half-open

let breakerState = 'CLOSED';   // CLOSED | OPEN | HALF_OPEN
let consecutiveFailures = 0;
let breakerOpenedAt = null;

function isCircuitOpen() {
  if (breakerState === 'CLOSED') return false;
  if (breakerState === 'OPEN') {
    // Check if cooldown has passed → transition to HALF_OPEN
    if (Date.now() - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
      breakerState = 'HALF_OPEN';
      console.log('[SelfHosted] Circuit breaker → HALF_OPEN (testing one request)');
      return false; // allow one request through
    }
    return true; // still cooling down
  }
  // HALF_OPEN: allow request through
  return false;
}

function recordSuccess() {
  if (breakerState !== 'CLOSED') {
    console.log('[SelfHosted] Circuit breaker → CLOSED (recovered)');
  }
  breakerState = 'CLOSED';
  consecutiveFailures = 0;
  breakerOpenedAt = null;
}

function recordFailure() {
  consecutiveFailures++;
  if (breakerState === 'HALF_OPEN' || consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerState = 'OPEN';
    breakerOpenedAt = Date.now();
    console.warn(`[SelfHosted] Circuit breaker → OPEN (${consecutiveFailures} failures). Cooldown ${BREAKER_COOLDOWN_MS / 1000}s`);
  }
}

// ─── Auth headers ────────────────────────────────────────────────────
function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (SELF_HOSTED_API_KEY) {
    headers['Authorization'] = `Bearer ${SELF_HOSTED_API_KEY}`;
  }
  return headers;
}

// ─── Determine timeout based on request parameters ───────────────────
function getTimeout(options = {}) {
  if (options.timeout) return options.timeout;
  const maxTokens = options.max_tokens || 500;
  const isJsonMode = options.response_format?.type === 'json_object';
  // B2B analysis pattern: high max_tokens + JSON mode
  if (maxTokens >= 4000 || (isJsonMode && maxTokens >= 2000)) {
    return TIMEOUT_ANALYSIS_MS;
  }
  return TIMEOUT_CHAT_MS;
}

// ─── Health Check ────────────────────────────────────────────────────
async function healthCheck() {
  if (!SELF_HOSTED_API_URL) {
    return { healthy: false, error: 'SELF_HOSTED_API_URL not configured', latencyMs: 0 };
  }

  const start = Date.now();
  try {
    // vLLM health endpoint — try /health first, fallback to /v1/models
    let response;
    try {
      response = await axios.get(`${SELF_HOSTED_API_URL}/health`, {
        headers: getHeaders(),
        timeout: 10000,
      });
    } catch {
      // Some vLLM versions don't have /health — try /v1/models
      const modelsUrl = SELF_HOSTED_API_URL.endsWith('/v1')
        ? `${SELF_HOSTED_API_URL}/models`
        : `${SELF_HOSTED_API_URL}/v1/models`;
      response = await axios.get(modelsUrl, {
        headers: getHeaders(),
        timeout: 10000,
      });
    }
    const latencyMs = Date.now() - start;
    return {
      healthy: true,
      latencyMs,
      model: SELF_HOSTED_MODEL,
      breaker: breakerState,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      latencyMs: Date.now() - start,
      breaker: breakerState,
    };
  }
}

// ─── Chat Completion (with retry + exponential backoff) ──────────────
// Same request/response format as OpenAI chat.completions.create
async function chatCompletion(params = {}) {
  if (!SELF_HOSTED_API_URL) {
    throw new Error('SELF_HOSTED_API_URL not configured');
  }

  const timeout = getTimeout(params);

  // Build the request body — same shape as OpenAI
  const body = {
    model: SELF_HOSTED_MODEL,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.max_tokens || 500,
  };

  // Optional fields — only include if provided
  if (params.top_p != null) body.top_p = params.top_p;
  if (params.tools && params.tools.length > 0) body.tools = params.tools;
  if (params.tool_choice) body.tool_choice = params.tool_choice;
  if (params.response_format) body.response_format = params.response_format;
  if (params.stop) body.stop = params.stop;

  const completionsUrl = SELF_HOSTED_API_URL.endsWith('/v1')
    ? `${SELF_HOSTED_API_URL}/chat/completions`
    : `${SELF_HOSTED_API_URL}/v1/chat/completions`;

  let lastError;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      const response = await axios.post(completionsUrl, body, {
        headers: getHeaders(),
        timeout,
      });
      // vLLM returns the same format as OpenAI — pass through directly
      return response.data;
    } catch (err) {
      lastError = err;
      const attemptsLeft = RETRY_MAX - attempt;
      if (attemptsLeft > 0 && isRetryable(err)) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt); // 500ms, 1000ms
        console.warn(`[SelfHosted] Attempt ${attempt + 1} failed (${err.code || err.message}). Retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        break;
      }
    }
  }
  throw lastError;
}

// ─── Streaming Timeouts ──────────────────────────────────────────────
// Controls how long to wait for the FIRST token and max silence between tokens.
// No total timeout — the connection stays alive as long as tokens keep arriving.
// Configurable via .env:
//   SELF_HOSTED_FIRST_TOKEN_MS — max wait for first token  (default 2 min)
//   SELF_HOSTED_SILENCE_MS     — max silence between tokens (default 3 min)
const FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env.SELF_HOSTED_FIRST_TOKEN_MS || '120000', 10); // 120s — A800 enforce-eager bajo carga paralela puede tardar 40-60s en prefill
const SILENCE_TIMEOUT_MS = parseInt(process.env.SELF_HOSTED_SILENCE_MS || '90000', 10);           // 90s — margen amplio para análisis largos con chunks paralelos

// ─── Chat Completion via Streaming ───────────────────────────────────
// Uses stream: true so tokens arrive progressively — no total timeout.
// The connection stays alive as long as tokens keep coming.
// Returns the SAME complete response object as chatCompletion() — no changes to callers.
//
// Error conditions (all propagate up to selfHostedBootstrap for fallback decision):
//   - No first token in FIRST_TOKEN_TIMEOUT_MS → server not responding → ETIMEDOUT
//   - Silence > SILENCE_TIMEOUT_MS between tokens → server hang → ETIMEDOUT
//   - Stream error event (network drop) → propagated as-is
//   - Error JSON in stream (vLLM server error) → propagated with isStreamError=true
async function chatCompletionStream(params = {}) {
  if (!SELF_HOSTED_API_URL) {
    throw new Error('SELF_HOSTED_API_URL not configured');
  }

  const maxOutputTokens = Math.min(params.max_tokens || 500, 1800);

  // Smart truncation: if input is too long, keep start + end of the longest message
  // Assumes ~3.5 chars per token for Spanish. Budget: 7000 - maxOutputTokens - 200 buffer.
  // 7000 input + 1800 output = 8800 tokens total — well within Qwen2.5-72B 32k context
  // Smaller budget = less prefill time = faster first token
  const maxInputChars = (7000 - maxOutputTokens - 200) * 3.5;
  const messages = params.messages ? [...params.messages] : [];
  const totalChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  if (totalChars > maxInputChars) {
    // Find longest user message (likely the transcript) and truncate its middle
    let longestIdx = -1, longestLen = 0;
    messages.forEach((m, i) => {
      const len = typeof m.content === 'string' ? m.content.length : 0;
      if (m.role === 'user' && len > longestLen) { longestLen = len; longestIdx = i; }
    });
    if (longestIdx >= 0) {
      const excess = totalChars - maxInputChars;
      const content = messages[longestIdx].content;
      const keepLen = Math.max(content.length - excess, 1000);
      const half = Math.floor(keepLen / 2);
      messages[longestIdx] = {
        ...messages[longestIdx],
        content: content.slice(0, half) + '\n...[transcripción truncada por límite de contexto]...\n' + content.slice(-half),
      };
    }
  }

  const body = {
    model: SELF_HOSTED_MODEL,
    messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: maxOutputTokens,
    stream: true,
  };

  if (params.top_p != null) body.top_p = params.top_p;
  if (params.tools && params.tools.length > 0) body.tools = params.tools;
  if (params.tool_choice) body.tool_choice = params.tool_choice;
  if (params.response_format) body.response_format = params.response_format;
  if (params.stop) body.stop = params.stop;

  const completionsUrl = SELF_HOSTED_API_URL.endsWith('/v1')
    ? `${SELF_HOSTED_API_URL}/chat/completions`
    : `${SELF_HOSTED_API_URL}/v1/chat/completions`;

  return new Promise(async (resolve, reject) => {
    let settled = false;
    let dataStream = null;
    let firstTokenTimer = null;
    let silenceTimer = null;

    // Accumulators
    let responseId = '';
    let accumulatedContent = '';
    let finishReason = null;
    let usage = null;
    let gotFirstToken = false;
    const toolCallMap = {}; // index → reconstructed tool_call object

    // ── Tool call text parser (fallback when vLLM parser doesn't produce structured deltas) ──
    // Detects Hermes XML format: <tool_call>{"name":"...","arguments":{...}}</tool_call>
    // AND bracket format:        [function_name {...args...}]
    const KNOWN_TOOLS = new Set(['get_products', 'create_order', 'save_voucher', 'get_pending_orders', 'save_webchat_lead', 'check_coverage', 'submit_lead']);
    function parseTextToolCalls(content) {
      if (!content) return [];
      const calls = [];

      // Pattern 1: Hermes <tool_call>...</tool_call>
      const hermesRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
      let m;
      while ((m = hermesRe.exec(content)) !== null) {
        try {
          const p = JSON.parse(m[1].trim());
          if (p.name) calls.push({ id: `tc-${Date.now()}-${calls.length}`, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments || p.parameters || {}) } });
        } catch {}
      }
      if (calls.length > 0) return calls;

      // Pattern 2: [function_name {"key":"val",...}] — Qwen text output fallback
      const bracketRe = /\[(\w+)\s+(\{[\s\S]*?\})\]/g;
      while ((m = bracketRe.exec(content)) !== null) {
        if (!KNOWN_TOOLS.has(m[1])) continue;
        try {
          const args = JSON.parse(m[2]);
          calls.push({ id: `tc-${Date.now()}-${calls.length}`, type: 'function', function: { name: m[1], arguments: JSON.stringify(args) } });
        } catch {}
      }
      return calls;
    }

    // Single resolve/reject gate — prevents double-settlement
    function done(result, err) {
      if (settled) return;
      settled = true;
      clearTimeout(firstTokenTimer);
      clearTimeout(silenceTimer);
      if (dataStream && !dataStream.destroyed) dataStream.destroy();
      if (err) reject(err);
      else resolve(result);
    }

    // Assemble the final OpenAI-compatible response object from accumulated state
    function buildResponse() {
      const indices = Object.keys(toolCallMap).sort((a, b) => Number(a) - Number(b));
      let toolCalls = indices.length > 0 ? indices.map(i => toolCallMap[i]) : undefined;
      let content = accumulatedContent || null;

      // Fallback: if no structured tool_calls arrived but content has Hermes/<bracket> patterns → parse them
      if (!toolCalls && content) {
        const parsed = parseTextToolCalls(content);
        if (parsed.length > 0) {
          toolCalls = parsed;
          content = null; // strip tool call text so user never sees raw JSON
        }
      }

      return {
        id: responseId || 'stream-response',
        object: 'chat.completion',
        choices: [{
          message: {
            role: 'assistant',
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason || (toolCalls ? 'tool_calls' : 'stop'),
          index: 0,
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    function onToken() {
      if (!gotFirstToken) {
        gotFirstToken = true;
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
      // Reset silence watchdog on every token
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const err = new Error(
          `[AI_TIMEOUT] Silencio entre tokens por más de ${SILENCE_TIMEOUT_MS / 1000}s — posible hang del servidor`
        );
        err.code = 'ETIMEDOUT';
        done(null, err);
      }, SILENCE_TIMEOUT_MS);
    }

    // First-token watchdog: server must send something within this window
    firstTokenTimer = setTimeout(() => {
      const err = new Error(
        `[AI_TIMEOUT] Sin primer token en ${FIRST_TOKEN_TIMEOUT_MS / 1000}s — servidor no responde`
      );
      err.code = 'ETIMEDOUT';
      done(null, err);
    }, FIRST_TOKEN_TIMEOUT_MS);

    try {
      const axiosResponse = await axios.post(completionsUrl, body, {
        headers: { ...getHeaders(), Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: 0, // disable axios timeout — managed by silence/first-token timers above
      });

      dataStream = axiosResponse.data;
      let lineBuffer = '';

      dataStream.on('data', (chunk) => {
        if (settled) return;
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep last incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();

          // Stream complete
          if (dataStr === '[DONE]') {
            done(buildResponse());
            return;
          }

          let chunkData;
          try { chunkData = JSON.parse(dataStr); } catch { continue; }

          // Server-side error embedded in stream (e.g. vLLM context overflow)
          if (chunkData.error) {
            const streamErr = new Error(
              typeof chunkData.error === 'string' ? chunkData.error
                : chunkData.error.message || JSON.stringify(chunkData.error)
            );
            streamErr.isStreamError = true;
            done(null, streamErr);
            return;
          }

          if (chunkData.id) responseId = chunkData.id;
          // vLLM sends usage in the final chunk
          if (chunkData.usage) usage = chunkData.usage;

          const choice = chunkData.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          // ── Content token ──────────────────────────────────────
          if (delta.content) {
            onToken();
            accumulatedContent += delta.content;
          }

          // ── Tool call deltas (reconstruct from fragments) ──────
          if (delta.tool_calls) {
            onToken();
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallMap[idx]) {
                toolCallMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallMap[idx].id = tc.id;
              if (tc.type) toolCallMap[idx].type = tc.type;
              if (tc.function?.name) toolCallMap[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallMap[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      });

      dataStream.on('error', (streamErr) => done(null, streamErr));

      dataStream.on('end', () => {
        if (settled) return;
        if (!gotFirstToken) {
          const err = new Error('[AI_TIMEOUT] Stream cerrado sin recibir tokens de respuesta');
          err.code = 'ETIMEDOUT';
          done(null, err);
          return;
        }
        // Stream ended without explicit [DONE] — use accumulated content
        done(buildResponse());
      });

    } catch (axiosErr) {
      // Connection-level failure (ECONNREFUSED, ENOTFOUND, etc.)
      done(null, axiosErr);
    }
  });
}

// ─── Generate Embedding ──────────────────────────────────────────────
async function generateEmbedding(input) {
  const url = SELF_HOSTED_EMBEDDING_URL || SELF_HOSTED_API_URL;
  if (!url) {
    throw new Error('No embedding URL configured');
  }

  const embeddingsUrl = url.endsWith('/v1')
    ? `${url}/embeddings`
    : `${url}/v1/embeddings`;

  const response = await axios.post(embeddingsUrl, {
    model: SELF_HOSTED_EMBEDDING_MODEL,
    input,
  }, {
    headers: getHeaders(),
    timeout: 30000,
  });

  return response.data;
}

// ─── Get Status (cached) ────────────────────────────────────────────
let cachedStatus = null;
let statusCacheTime = 0;
const STATUS_CACHE_TTL = 30000; // 30s

async function getStatus() {
  if (cachedStatus && Date.now() - statusCacheTime < STATUS_CACHE_TTL) {
    return cachedStatus;
  }
  const health = await healthCheck();
  cachedStatus = {
    ...health,
    configured: !!SELF_HOSTED_API_URL,
    circuitBreaker: breakerState,
    consecutiveFailures,
  };
  statusCacheTime = Date.now();
  return cachedStatus;
}

// ─── Exported helpers for the bootstrap proxy ────────────────────────
function isConfigured() {
  return !!SELF_HOSTED_API_URL;
}

function getCircuitBreakerState() {
  return { state: breakerState, failures: consecutiveFailures };
}

module.exports = {
  healthCheck,
  chatCompletion,          // kept as non-streaming backup
  chatCompletionStream,    // primary — stream-based, no total timeout
  generateEmbedding,
  getStatus,
  isConfigured,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  getCircuitBreakerState,
  getTimeout,
  // Constants for external use
  TIMEOUT_CHAT_MS,
  TIMEOUT_ANALYSIS_MS,
};
