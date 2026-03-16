/**
 * AI Provider Service — Multi-model support
 *
 * Routing strategy:
 *   planType === 'trial'  AND GROQ_API_KEY set  →  Groq (llama-3.3-70b, free tier)
 *   planType === 'basic'  OR no Groq configured  →  OpenAI gpt-4o-mini (no tools)
 *   planType === 'pro' / 'active' / default       →  OpenAI gpt-4o-mini (with tools)
 *
 * Groq advantages:
 *   - Free tier: 14,400 req/day, 500K tokens/min
 *   - Very fast inference (~250 tokens/s)
 *   - No function calling used (trial users don't have products)
 *
 * OpenAI advantages:
 *   - Reliable function calling (tools: get_products, create_order, etc.)
 *   - Multimodal (image voucher validation)
 *   - Consistent quality for paying clients
 */

const OpenAI = require('openai');

// Lazy-load Groq so missing package gives a clear error on first use, not startup
let _groqClient = null;
const getGroqClient = () => {
  if (_groqClient) return _groqClient;
  try {
    const Groq = require('groq-sdk');
    _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return _groqClient;
  } catch {
    throw new Error('groq-sdk not installed. Run: npm install groq-sdk');
  }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OPENAI_MODEL = 'gpt-4o-mini';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

const DEFAULT_TIMEOUT_MS = 25000;

// =====================================================
// PROVIDER SELECTION
// =====================================================

/**
 * Returns which AI provider to use based on the service plan.
 * Falls back to 'openai' if GROQ_API_KEY is not configured.
 *
 * @param {string} planType — 'trial' | 'basic' | 'pro' | 'active' | etc.
 * @returns {'groq' | 'openai'}
 */
const getProvider = (planType) => {
  if (planType === 'trial' && process.env.GROQ_API_KEY) {
    return 'groq';
  }
  return 'openai';
};

// =====================================================
// CHAT COMPLETION
// =====================================================

/**
 * Unified interface for a single chat completion call.
 *
 * Note: tools/function-calling is ONLY supported by the 'openai' provider.
 * When provider is 'groq', tools/toolChoice are silently ignored.
 *
 * @param {string}   provider    — 'openai' | 'groq'
 * @param {Array}    messages    — OpenAI-format messages array
 * @param {Object}   options
 * @param {number}   [options.maxTokens=500]
 * @param {number}   [options.temperature=0.7]
 * @param {Array}    [options.tools]          — function-calling tools (openai only)
 * @param {string}   [options.toolChoice]     — 'auto' | 'none' (openai only)
 * @param {number}   [options.timeoutMs]
 * @returns {Object} — raw completion object (same shape for both providers)
 */
const createChatCompletion = async (provider, messages, options = {}) => {
  const {
    maxTokens   = 500,
    temperature = 0.7,
    tools       = undefined,
    toolChoice  = undefined,
    timeoutMs   = DEFAULT_TIMEOUT_MS,
  } = options;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`AI provider timeout (${timeoutMs / 1000}s)`)), timeoutMs)
  );

  if (provider === 'groq') {
    const groq = getGroqClient();
    return Promise.race([
      groq.chat.completions.create({
        model:       GROQ_MODEL,
        messages,
        max_tokens:  maxTokens,
        temperature,
        // tools not passed — Groq trial users don't have product catalog feature
      }),
      timeoutPromise,
    ]);
  }

  // Default: OpenAI
  return Promise.race([
    openai.chat.completions.create({
      model:             OPENAI_MODEL,
      messages,
      max_tokens:        maxTokens,
      temperature,
      presence_penalty:  0.1,
      frequency_penalty: 0.1,
      tools,
      tool_choice:       toolChoice,
    }),
    timeoutPromise,
  ]);
};

/**
 * Second completion call after tool execution (post-function-calling round).
 * Always uses OpenAI because only OpenAI supports tools.
 *
 * @param {Array}  messages   — full messages array including tool results
 * @param {Object} options
 * @returns {Object} — raw completion
 */
const createToolResultCompletion = async (messages, options = {}) => {
  const {
    maxTokens   = 500,
    temperature = 0.7,
    timeoutMs   = DEFAULT_TIMEOUT_MS,
  } = options;

  return Promise.race([
    openai.chat.completions.create({
      model:             OPENAI_MODEL,
      messages,
      max_tokens:        maxTokens,
      temperature,
      presence_penalty:  0.1,
      frequency_penalty: 0.1,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI tool-result timeout')), timeoutMs)
    ),
  ]);
};

module.exports = {
  getProvider,
  createChatCompletion,
  createToolResultCompletion,
  OPENAI_MODEL,
  GROQ_MODEL,
};
