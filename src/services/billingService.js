/**
 * Billing Service — Pay-As-You-Go (PAYG)
 *
 * Handles:
 * 1. recordTokenUsage()       — persists token_usage row for every AI response
 * 2. deductCredits()          — atomically deducts from credit_balance (PAYG only)
 * 3. checkBalance()           — returns current balance for a service
 * 4. addCredits()             — admin adds credits after a payment
 * 5. getMonthlyUsage()        — aggregated usage for billing period
 * 6. processPaygResponse()    — combined: record + deduct + check balance (used in webhook)
 *
 * Pricing (95% margin — 20x markup):
 *   We charge: input $0.003/1K tokens, output $0.012/1K tokens
 *   OpenAI costs: input $0.00015/1K, output $0.0006/1K
 *   Per message avg (1600 input + 300 output): cost $0.00042, billed $0.0084
 */

const { query } = require('../config/database');
const { PAYG } = require('../config/constants');

// =====================================================
// COST CALCULATION HELPERS
// =====================================================

/**
 * Calculate our cost (what we pay OpenAI) in USD
 */
const calcOpenAICost = (inputTokens, outputTokens) => {
  return (
    (inputTokens  / 1000) * PAYG.OPENAI_INPUT_PER_1K +
    (outputTokens / 1000) * PAYG.OPENAI_OUTPUT_PER_1K
  );
};

/**
 * Calculate what we bill the client in USD.
 * Uses per-service custom pricing if provided, otherwise falls back to global constants.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {{ input_price_per_1k?: number, output_price_per_1k?: number }} [customPricing]
 */
const calcBilledAmount = (inputTokens, outputTokens, customPricing = null) => {
  const inputRate  = customPricing?.input_price_per_1k  ?? PAYG.INPUT_PRICE_PER_1K;
  const outputRate = customPricing?.output_price_per_1k ?? PAYG.OUTPUT_PRICE_PER_1K;
  return (
    (inputTokens  / 1000) * inputRate +
    (outputTokens / 1000) * outputRate
  );
};

// =====================================================
// RECORD TOKEN USAGE
// =====================================================

/**
 * Persists a token_usage row after every AI response.
 * Called for ALL plan types — this is the usage ledger.
 *
 * @param {Object} params
 * @param {string} params.clientId
 * @param {string} params.clientServiceId
 * @param {string} params.conversationId
 * @param {string} params.messageId        — ID of the bot's message row
 * @param {number} params.inputTokens
 * @param {number} params.outputTokens
 * @param {string} params.provider         — 'openai' | 'groq'
 * @param {string} params.model
 * @param {string} params.planType
 * @returns {Promise<Object>} — the inserted row
 */
const recordTokenUsage = async ({
  clientId,
  clientServiceId,
  conversationId,
  messageId,
  inputTokens,
  outputTokens,
  provider = 'openai',
  model = 'gpt-4o-mini',
  planType = 'pro',
  paygPricing = null,
}) => {
  const costUsd   = calcOpenAICost(inputTokens, outputTokens);
  const billedUsd = planType === PAYG.PLAN_TYPE
    ? calcBilledAmount(inputTokens, outputTokens, paygPricing)
    : 0; // Fixed-plan clients are not billed per-token

  const result = await query(
    `INSERT INTO token_usage
       (client_id, client_service_id, conversation_id, message_id,
        input_tokens, output_tokens, provider, model, cost_usd, billed_usd, plan_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      clientId, clientServiceId, conversationId, messageId,
      inputTokens, outputTokens, provider, model,
      costUsd.toFixed(8), billedUsd.toFixed(8), planType,
    ]
  );

  return result.rows[0];
};

// =====================================================
// PAYG CREDIT MANAGEMENT
// =====================================================

/**
 * Check current credit balance for a service (PAYG clients).
 * @returns {{ balance: number, isLow: boolean, isEmpty: boolean }}
 */
const checkBalance = async (clientServiceId) => {
  const result = await query(
    'SELECT credit_balance FROM client_services WHERE id = $1',
    [clientServiceId]
  );

  if (result.rows.length === 0) return { balance: 0, isLow: true, isEmpty: true };

  const balance = parseFloat(result.rows[0].credit_balance) || 0;
  return {
    balance,
    isLow:   balance <= PAYG.LOW_BALANCE_ALERT_USD,
    isEmpty: balance <= 0,
  };
};

/**
 * Atomically deducts billedAmount from credit_balance.
 * Returns the new balance.
 * @returns {number} newBalance
 */
const deductCredits = async (clientServiceId, billedAmount) => {
  const result = await query(
    `UPDATE client_services
     SET credit_balance = credit_balance - $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING credit_balance`,
    [billedAmount.toFixed(8), clientServiceId]
  );

  return parseFloat(result.rows[0]?.credit_balance) || 0;
};

/**
 * Admin adds credits to a PAYG client service.
 * Usually called after a payment is validated.
 *
 * @param {string} clientServiceId
 * @param {number} amountUsd
 * @param {string} notes — optional reason (e.g., "PayPal payment #xxx")
 * @returns {{ newBalance: number }}
 */
const addCredits = async (clientServiceId, amountUsd, notes = '') => {
  const result = await query(
    `UPDATE client_services
     SET credit_balance = credit_balance + $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING credit_balance, client_id`,
    [parseFloat(amountUsd).toFixed(4), clientServiceId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Service ${clientServiceId} not found`);
  }

  const newBalance = parseFloat(result.rows[0].credit_balance);

  console.log(`[Billing] Added $${amountUsd} credits to service ${clientServiceId}. New balance: $${newBalance}. ${notes}`);

  return { newBalance };
};

// =====================================================
// COMBINED PROCESS (used in webhookController)
// =====================================================

/**
 * Full PAYG billing flow after an AI response:
 * 1. Record token usage
 * 2. Deduct from credit balance
 * 3. Return new balance + low-balance warning
 *
 * @returns {{ newBalance: number, isLow: boolean, isEmpty: boolean, billedUsd: number }}
 */
const processPaygResponse = async ({
  clientId,
  clientServiceId,
  conversationId,
  messageId,
  inputTokens,
  outputTokens,
  provider,
  model,
  paygPricing = null, // Per-service custom pricing override
}) => {
  const billedUsd = calcBilledAmount(inputTokens, outputTokens, paygPricing);

  // Record usage
  await recordTokenUsage({
    clientId,
    clientServiceId,
    conversationId,
    messageId,
    inputTokens,
    outputTokens,
    provider,
    model,
    planType: PAYG.PLAN_TYPE,
    paygPricing,
  });

  // Deduct credits
  const newBalance = await deductCredits(clientServiceId, billedUsd);

  return {
    newBalance,
    billedUsd,
    isLow:   newBalance <= PAYG.LOW_BALANCE_ALERT_USD,
    isEmpty: newBalance <= 0,
  };
};

// =====================================================
// REPORTING
// =====================================================

/**
 * Monthly usage aggregation for a client.
 * @param {string} clientId
 * @param {number} year   — e.g. 2026
 * @param {number} month  — 1-12
 * @returns {Object}
 */
const getMonthlyUsage = async (clientId, year, month) => {
  const result = await query(
    `SELECT
       plan_type,
       SUM(input_tokens)  AS total_input_tokens,
       SUM(output_tokens) AS total_output_tokens,
       SUM(total_tokens)  AS total_tokens,
       SUM(cost_usd)      AS total_cost_usd,
       SUM(billed_usd)    AS total_billed_usd,
       COUNT(*)           AS total_responses
     FROM token_usage
     WHERE client_id = $1
       AND EXTRACT(YEAR  FROM created_at) = $2
       AND EXTRACT(MONTH FROM created_at) = $3
     GROUP BY plan_type`,
    [clientId, year, month]
  );

  const totals = {
    totalInputTokens:   0,
    totalOutputTokens:  0,
    totalTokens:        0,
    totalCostUsd:       0,
    totalBilledUsd:     0,
    totalResponses:     0,
    byPlan: result.rows,
  };

  for (const row of result.rows) {
    totals.totalInputTokens  += parseInt(row.total_input_tokens)  || 0;
    totals.totalOutputTokens += parseInt(row.total_output_tokens) || 0;
    totals.totalTokens       += parseInt(row.total_tokens)        || 0;
    totals.totalCostUsd      += parseFloat(row.total_cost_usd)    || 0;
    totals.totalBilledUsd    += parseFloat(row.total_billed_usd)  || 0;
    totals.totalResponses    += parseInt(row.total_responses)     || 0;
  }

  return totals;
};

/**
 * Daily usage for the last N days (for charts)
 */
const getDailyUsage = async (clientServiceId, days = 30) => {
  const safeDays = Math.max(1, Math.min(365, parseInt(days) || 30));
  const result = await query(
    `SELECT
       DATE(created_at) AS date,
       SUM(input_tokens + output_tokens) AS tokens,
       SUM(billed_usd)                   AS billed_usd,
       COUNT(*)                          AS responses
     FROM token_usage
     WHERE client_service_id = $1
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     GROUP BY DATE(created_at)
     ORDER BY date ASC`,
    [clientServiceId, String(safeDays)]
  );

  return result.rows;
};

/**
 * All-clients usage summary for admin dashboard
 */
const getAllClientsUsageSummary = async (year, month) => {
  const result = await query(
    `SELECT
       c.id AS client_id,
       c.name AS client_name,
       c.email,
       SUM(tu.total_tokens)  AS total_tokens,
       SUM(tu.cost_usd)      AS total_cost_usd,
       SUM(tu.billed_usd)    AS total_billed_usd,
       COUNT(tu.id)          AS total_responses
     FROM clients c
     LEFT JOIN token_usage tu ON tu.client_id = c.id
       AND EXTRACT(YEAR  FROM tu.created_at) = $1
       AND EXTRACT(MONTH FROM tu.created_at) = $2
     GROUP BY c.id, c.name, c.email
     ORDER BY total_billed_usd DESC NULLS LAST`,
    [year, month]
  );

  return result.rows;
};

module.exports = {
  calcOpenAICost,
  calcBilledAmount,
  recordTokenUsage,
  checkBalance,
  deductCredits,
  addCredits,
  processPaygResponse,
  getMonthlyUsage,
  getDailyUsage,
  getAllClientsUsageSummary,
};
