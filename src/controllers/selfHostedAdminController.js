const { query } = require('../config/database');
const selfHostedAI = require('../services/selfHostedAIService');
const aiMetrics = require('../services/aiMetricsService');
const bootstrap = require('../services/selfHostedBootstrap');

// ─── GET /admin/ai-provider — Estado actual ──────────────────────────
async function getAIProviderStatus(req, res) {
  try {
    // Get mode from DB
    const modeResult = await query("SELECT value FROM system_config WHERE key = 'ai_provider_mode'");
    const mode = modeResult.rows[0] ? JSON.parse(modeResult.rows[0].value) : 'external';

    // Get health status
    const health = await selfHostedAI.getStatus();

    // Get metrics summary
    const metrics = aiMetrics.getSummary();
    const savings = aiMetrics.getEstimatedSavings();

    res.json({
      mode,
      server: {
        configured: health.configured,
        healthy: health.healthy,
        latencyMs: health.latencyMs,
        model: health.model || process.env.SELF_HOSTED_MODEL || 'not configured',
        circuitBreaker: health.circuitBreaker,
        url: process.env.SELF_HOSTED_API_URL ? '✓ configured' : '✗ not set',
      },
      metrics,
      savings,
    });
  } catch (error) {
    console.error('[AI Provider Admin] Error getting status:', error.message);
    res.status(500).json({ error: 'Error al obtener estado del proveedor IA' });
  }
}

// ─── PUT /admin/ai-provider/mode — Cambiar modo ─────────────────────
async function updateAIProviderMode(req, res) {
  try {
    const { mode } = req.body;
    if (!['self-hosted', 'external', 'auto'].includes(mode)) {
      return res.status(400).json({ error: 'Modo inválido. Usa: self-hosted, external, auto' });
    }

    // Validate server is reachable before enabling self-hosted
    if (mode === 'self-hosted' || mode === 'auto') {
      if (!selfHostedAI.isConfigured()) {
        return res.status(400).json({
          error: 'Servidor self-hosted no configurado. Configura SELF_HOSTED_API_URL en .env',
        });
      }

      const health = await selfHostedAI.healthCheck();
      if (!health.healthy) {
        return res.status(400).json({
          error: `Servidor self-hosted no responde: ${health.error}. Verifica que esté activo.`,
          health,
        });
      }
    }

    // Update in DB
    await query(
      `UPDATE system_config SET value = $1 WHERE key = 'ai_provider_mode'`,
      [JSON.stringify(mode)]
    );

    // Update in-memory immediately
    bootstrap.setMode(mode);

    console.log(`[AI Provider Admin] Mode changed to: ${mode}`);
    res.json({ mode, message: `Modo IA cambiado a: ${mode}` });
  } catch (error) {
    console.error('[AI Provider Admin] Error updating mode:', error.message);
    res.status(500).json({ error: 'Error al actualizar modo' });
  }
}

// ─── POST /admin/ai-provider/health-check — Health check manual ──────
async function triggerHealthCheck(req, res) {
  try {
    const health = await selfHostedAI.healthCheck();

    // Update cached status in DB
    await query(
      `UPDATE system_config SET value = $1 WHERE key = 'self_hosted_status'`,
      [JSON.stringify({ ...health, lastCheck: new Date().toISOString() })]
    );

    res.json(health);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ─── GET /admin/ai-provider/metrics — Métricas detalladas ────────────
async function getDetailedMetrics(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const detailed = aiMetrics.getDetailed(limit);
    res.json(detailed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ─── POST /admin/ai-provider/test — Prueba comparativa ──────────────
async function testCompletion(req, res) {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Se requiere un prompt de prueba' });
    }

    const messages = [
      { role: 'system', content: 'Eres un asistente útil. Responde en español de forma concisa.' },
      { role: 'user', content: prompt },
    ];

    const results = {};

    // Test self-hosted
    if (selfHostedAI.isConfigured()) {
      const start = Date.now();
      try {
        const response = await selfHostedAI.chatCompletion({
          messages,
          max_tokens: 200,
          temperature: 0.7,
        });
        results.selfHosted = {
          success: true,
          response: response.choices?.[0]?.message?.content || '',
          latencyMs: Date.now() - start,
          tokens: response.usage || {},
        };
      } catch (error) {
        results.selfHosted = {
          success: false,
          error: error.message,
          latencyMs: Date.now() - start,
        };
      }
    } else {
      results.selfHosted = { success: false, error: 'No configurado' };
    }

    // Test OpenAI (using existing provider)
    try {
      const OpenAI = require('openai');
      // Create a REAL OpenAI client (not proxied) for comparison
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const start = Date.now();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 200,
        temperature: 0.7,
      });
      results.openai = {
        success: true,
        response: response.choices?.[0]?.message?.content || '',
        latencyMs: Date.now() - start,
        tokens: response.usage || {},
      };
    } catch (error) {
      results.openai = {
        success: false,
        error: error.message,
      };
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  getAIProviderStatus,
  updateAIProviderMode,
  triggerHealthCheck,
  getDetailedMetrics,
  testCompletion,
};
