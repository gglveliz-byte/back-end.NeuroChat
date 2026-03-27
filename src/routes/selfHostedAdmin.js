const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/selfHostedAdminController');

// GET  /admin/ai-provider          — Estado actual: modo, health, métricas
router.get('/', ctrl.getAIProviderStatus);

// PUT  /admin/ai-provider/mode     — Cambiar modo: { mode: 'self-hosted' | 'external' | 'auto' }
router.put('/mode', ctrl.updateAIProviderMode);

// POST /admin/ai-provider/health-check — Trigger health check manual
router.post('/health-check', ctrl.triggerHealthCheck);

// GET  /admin/ai-provider/metrics  — Métricas detalladas con historial reciente
router.get('/metrics', ctrl.getDetailedMetrics);

// POST /admin/ai-provider/test     — Prueba comparativa: self-hosted vs OpenAI
router.post('/test', ctrl.testCompletion);

module.exports = router;
