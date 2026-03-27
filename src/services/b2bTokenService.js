const { query } = require('../config/database');

// Pricing per 1K tokens (USD)
const MODEL_RATES = {
  'gpt-4o':       { input: 0.005,   output: 0.015  },
  'gpt-4o-mini':  { input: 0.00015, output: 0.0006 },
};

// Whisper-1 charges per minute of audio
const WHISPER_RATE_PER_MIN = 0.006;

function getCostUsd(model, inputTokens, outputTokens) {
  const key = Object.keys(MODEL_RATES).find(k => model.includes(k)) || 'gpt-4o-mini';
  const rates = MODEL_RATES[key];
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

/**
 * Record token usage for a B2B pipeline step.
 * @param {Object} params
 * @param {string} params.b2bClientId
 * @param {string} params.interactionId
 * @param {string} params.step  — 'remap' | 'filter' | 'analyze' | 'director'
 * @param {Object} params.usage — { inputTokens, outputTokens, totalTokens, model }
 */
async function recordB2bTokenUsage({ b2bClientId, interactionId, step, usage }) {
  if (!usage || !b2bClientId) return;
  try {
    const model = usage.model || 'gpt-4o-mini';
    const costUsd = getCostUsd(model, usage.inputTokens || 0, usage.outputTokens || 0);
    await query(
      `INSERT INTO b2b_token_usage
         (b2b_client_id, interaction_id, step, model, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        b2bClientId,
        interactionId || null,
        step,
        model,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.totalTokens || 0,
        costUsd.toFixed(6),
      ]
    );
  } catch (err) {
    if (err.code === '23503') {
      // FK violation — interaction_id not found in b2b_interactions (schema mismatch or race condition)
      // Retry without interaction link so billing is still recorded
      try {
        await query(
          `INSERT INTO b2b_token_usage
             (b2b_client_id, interaction_id, step, model, input_tokens, output_tokens, total_tokens, cost_usd)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
          [
            b2bClientId,
            step,
            usage.model || 'gpt-4o-mini',
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            usage.totalTokens || 0,
            getCostUsd(usage.model || 'gpt-4o-mini', usage.inputTokens || 0, usage.outputTokens || 0).toFixed(6),
          ]
        );
      } catch { /* truly non-blocking */ }
    } else {
      console.error('[B2B Token] Record failed (non-blocking):', err.message);
    }
  }
}

/**
 * Record transcription cost when OpenAI Whisper-1 fallback was used.
 * Charges $0.006/min of audio.
 */
async function recordB2bTranscriptionCost({ b2bClientId, interactionId, audioDurationSecs }) {
  if (!b2bClientId || !audioDurationSecs) return;
  try {
    const durationMins = audioDurationSecs / 60;
    const costUsd = durationMins * WHISPER_RATE_PER_MIN;
    const durationSecsInt = Math.round(audioDurationSecs);
    await query(
      `INSERT INTO b2b_token_usage
         (b2b_client_id, interaction_id, step, model, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        b2bClientId,
        interactionId || null,
        'transcribe',
        'whisper-1',
        durationSecsInt, // stored as seconds for reference
        0,
        durationSecsInt,
        costUsd.toFixed(6),
      ]
    );
    console.log(`[B2B Token] Transcription cost recorded: ${durationMins.toFixed(2)} min = $${costUsd.toFixed(4)}`);
  } catch (err) {
    if (err.code === '23503') {
      try {
        await query(
          `INSERT INTO b2b_token_usage
             (b2b_client_id, interaction_id, step, model, input_tokens, output_tokens, total_tokens, cost_usd)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
          [b2bClientId, 'transcribe', 'whisper-1', durationSecsInt, 0, durationSecsInt, costUsd.toFixed(6)]
        );
      } catch { /* truly non-blocking */ }
    } else {
      console.error('[B2B Token] Transcription record failed (non-blocking):', err.message);
    }
  }
}

/**
 * Get token usage summary for a B2B client.
 * Returns daily totals and per-interaction breakdown.
 */
async function getClientTokenUsage(b2bClientId, days = 30) {
  const [daily, perStep, recent] = await Promise.all([
    // Daily totals
    query(
      `SELECT
         DATE(created_at) as date,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(total_tokens) as total_tokens,
         SUM(cost_usd) as cost_usd,
         COUNT(DISTINCT interaction_id) as interactions
       FROM b2b_token_usage
       WHERE b2b_client_id = $1
         AND created_at >= NOW() - INTERVAL '${days} days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [b2bClientId]
    ),
    // Per-step totals (last 30 days)
    query(
      `SELECT
         step,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(cost_usd) as cost_usd,
         COUNT(*) as calls
       FROM b2b_token_usage
       WHERE b2b_client_id = $1
         AND created_at >= NOW() - INTERVAL '${days} days'
       GROUP BY step
       ORDER BY cost_usd DESC`,
      [b2bClientId]
    ),
    // Recent 20 interactions with cost
    query(
      `SELECT
         t.interaction_id,
         i.audio_filename,
         i.created_at as interaction_at,
         SUM(t.input_tokens) as input_tokens,
         SUM(t.output_tokens) as output_tokens,
         SUM(t.cost_usd) as cost_usd,
         array_agg(t.step ORDER BY t.created_at) as steps
       FROM b2b_token_usage t
       LEFT JOIN b2b_interactions i ON i.id = t.interaction_id
       WHERE t.b2b_client_id = $1
         AND t.created_at >= NOW() - INTERVAL '${days} days'
         AND t.interaction_id IS NOT NULL
       GROUP BY t.interaction_id, i.audio_filename, i.created_at
       ORDER BY i.created_at DESC NULLS LAST
       LIMIT 20`,
      [b2bClientId]
    ),
  ]);

  const totalResult = await query(
    `SELECT
       SUM(cost_usd) as total_cost,
       SUM(total_tokens) as total_tokens,
       COUNT(DISTINCT interaction_id) as total_interactions
     FROM b2b_token_usage
     WHERE b2b_client_id = $1
       AND created_at >= NOW() - INTERVAL '${days} days'`,
    [b2bClientId]
  );

  return {
    period_days: days,
    totals: totalResult.rows[0],
    daily: daily.rows,
    by_step: perStep.rows,
    recent_interactions: recent.rows,
  };
}

module.exports = { recordB2bTokenUsage, recordB2bTranscriptionCost, getClientTokenUsage };
