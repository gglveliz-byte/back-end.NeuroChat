// ─── AI Metrics Service ───────────────────────────────────────────────
// Tracks every AI call: provider used, latency, fallback rate, tokens.
// Buffer in memory, flush to system_config every 5 minutes.

// ─── In-memory buffer ────────────────────────────────────────────────
const metricsBuffer = [];
const MAX_BUFFER_SIZE = 1000;

// ─── Aggregated counters (survive flushes) ───────────────────────────
const counters = {
  total: 0,
  selfHosted: 0,
  openai: 0,
  groq: 0,
  gemini: 0,
  fallbacks: 0,
  failures: 0,
  totalLatencyMs: 0,
  selfHostedLatencyMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  // Per-provider token counters (for accurate savings)
  selfHostedInputTokens: 0,
  selfHostedOutputTokens: 0,
  openaiInputTokens: 0,
  openaiOutputTokens: 0,
  // Per-service counters
  byService: {},
};

// ─── Record a single AI call ─────────────────────────────────────────
function record(entry) {
  const metric = {
    provider: entry.provider || 'unknown',
    service: entry.service || 'unknown',
    latencyMs: entry.latencyMs || 0,
    success: entry.success !== false,
    fallback: entry.fallback || false,
    reason: entry.reason || '',
    inputTokens: entry.inputTokens || 0,
    outputTokens: entry.outputTokens || 0,
    timestamp: new Date(),
  };

  // Update counters
  counters.total++;
  counters[metric.provider] = (counters[metric.provider] || 0) + 1;
  if (metric.fallback) counters.fallbacks++;
  if (!metric.success) counters.failures++;
  counters.totalLatencyMs += metric.latencyMs;
  counters.totalInputTokens += metric.inputTokens;
  counters.totalOutputTokens += metric.outputTokens;
  // Per-provider token tracking
  if (metric.provider === 'self-hosted') {
    counters.selfHostedLatencyMs += metric.latencyMs;
    counters.selfHostedInputTokens += metric.inputTokens;
    counters.selfHostedOutputTokens += metric.outputTokens;
  } else if (metric.provider === 'openai') {
    counters.openaiInputTokens += metric.inputTokens;
    counters.openaiOutputTokens += metric.outputTokens;
  }

  // Per-service
  if (!counters.byService[metric.service]) {
    counters.byService[metric.service] = { total: 0, selfHosted: 0, fallback: 0, failures: 0 };
  }
  const svc = counters.byService[metric.service];
  svc.total++;
  if (metric.provider === 'self-hosted') svc.selfHosted++;
  if (metric.fallback) svc.fallback++;
  if (!metric.success) svc.failures++;

  // Buffer for recent history
  metricsBuffer.push(metric);
  if (metricsBuffer.length > MAX_BUFFER_SIZE) {
    metricsBuffer.splice(0, metricsBuffer.length - MAX_BUFFER_SIZE);
  }
}

// ─── Get summary ─────────────────────────────────────────────────────
function getSummary() {
  const selfHostedCount = counters.selfHosted || 0;
  const totalCount = counters.total || 1; // avoid division by zero

  return {
    total: counters.total,
    providers: {
      'self-hosted': counters.selfHosted || 0,
      openai: counters.openai || 0,
      groq: counters.groq || 0,
      gemini: counters.gemini || 0,
    },
    fallbackRate: counters.total > 0 ? Math.round((counters.fallbacks / totalCount) * 100) : 0,
    failureRate: counters.total > 0 ? Math.round((counters.failures / totalCount) * 100) : 0,
    avgLatencyMs: counters.total > 0 ? Math.round(counters.totalLatencyMs / totalCount) : 0,
    avgSelfHostedLatencyMs: selfHostedCount > 0 ? Math.round(counters.selfHostedLatencyMs / selfHostedCount) : 0,
    selfHostedPercentage: Math.round((selfHostedCount / totalCount) * 100),
    tokens: {
      input: counters.totalInputTokens,
      output: counters.totalOutputTokens,
      total: counters.totalInputTokens + counters.totalOutputTokens,
    },
    byService: counters.byService,
  };
}

// ─── Get detailed metrics (recent buffer) ────────────────────────────
function getDetailed(limit = 50) {
  return {
    summary: getSummary(),
    recent: metricsBuffer.slice(-limit).reverse(),
    circuitBreaker: require('./selfHostedAIService').getCircuitBreakerState(),
  };
}

// ─── Cost savings estimate ───────────────────────────────────────────
// Pricing reference (as of 2025):
//   gpt-4o-mini:  $0.15/1M input,  $0.60/1M output
//   gpt-4o:       $2.50/1M input, $10.00/1M output
//
// Strategy: B2B auditor calls (b2b-auditor service) would use gpt-4o.
// Everything else would use gpt-4o-mini.
// We calculate what those tokens WOULD have cost on OpenAI vs. $0 on self-hosted.
function getEstimatedSavings() {
  const b2bAuditor = counters.byService['b2b-auditor'] || { selfHosted: 0, total: 0 };

  // Ratio of b2b-auditor calls within self-hosted total
  const totalSH = counters.selfHosted || 0;
  const auditorSHRatio = totalSH > 0 ? (b2bAuditor.selfHosted || 0) / totalSH : 0;

  // Split self-hosted tokens proportionally between auditor (gpt-4o) and rest (gpt-4o-mini)
  const shInput  = counters.selfHostedInputTokens || 0;
  const shOutput = counters.selfHostedOutputTokens || 0;

  const auditorInput  = Math.round(shInput  * auditorSHRatio);
  const auditorOutput = Math.round(shOutput * auditorSHRatio);
  const miniInput     = shInput  - auditorInput;
  const miniOutput    = shOutput - auditorOutput;

  // What those tokens would have cost on OpenAI
  const auditorCost = (auditorInput / 1_000_000) * 2.50 + (auditorOutput / 1_000_000) * 10.00;
  const miniCost    = (miniInput    / 1_000_000) * 0.15 + (miniOutput    / 1_000_000) *  0.60;
  const totalSavings = auditorCost + miniCost;

  return {
    estimatedSavingsUSD: Math.round(totalSavings * 100) / 100,
    selfHostedCalls: totalSH,
    selfHostedTokens: { input: shInput, output: shOutput },
    breakdown: {
      auditorCostSaved: Math.round(auditorCost * 100) / 100,
      miniCostSaved:    Math.round(miniCost    * 100) / 100,
    },
    note: 'Calculated from actual tokens × OpenAI list price',
  };
}

// ─── Flush to DB (periodic) ──────────────────────────────────────────
let flushInterval = null;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function flushToDB() {
  try {
    const { query } = require('../config/database');
    const summary = getSummary();
    const savings = getEstimatedSavings();
    const metricsData = JSON.stringify({ ...summary, savings, lastFlush: new Date().toISOString() });

    await query(
      `UPDATE system_config SET value = $1 WHERE key = 'self_hosted_metrics'`,
      [metricsData]
    );
  } catch {
    // DB not available — metrics stay in memory
  }
}

function startPeriodicFlush() {
  if (flushInterval) return;
  flushInterval = setInterval(() => flushToDB().catch(() => {}), FLUSH_INTERVAL_MS);
  // Don't prevent process exit
  if (flushInterval.unref) flushInterval.unref();
}

// Auto-start flush when first record comes in
const originalRecord = record;
let flushStarted = false;

module.exports = {
  record(entry) {
    originalRecord(entry);
    if (!flushStarted) {
      flushStarted = true;
      startPeriodicFlush();
    }
  },
  getSummary,
  getDetailed,
  getEstimatedSavings,
  flushToDB,
};
