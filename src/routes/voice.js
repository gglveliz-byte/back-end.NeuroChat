const express = require('express');
const router = express.Router();
const voiceController = require('../controllers/voiceController');
const { authenticate, clientOnly } = require('../middlewares/auth');

// =====================================================
// WEBHOOKS DE VOXIMPLANT (sin autenticación JWT)
// VoxEngine llama directamente a estos endpoints
// Seguridad: X-Voximplant-Secret header
// =====================================================

// VoxEngine: nueva llamada entrante
router.post('/call-start', voiceController.callStart);

// VoxEngine: procesar audio del usuario → retornar audio de respuesta IA
router.post('/process-audio', voiceController.processAudio);

// VoxEngine: llamada terminada → registrar métricas y billing
router.post('/call-end', voiceController.callEnd);

// VoxEngine: tiempo máximo alcanzado → retornar número de transferencia
router.post('/timeout-transfer', voiceController.timeoutTransfer);

// =====================================================
// ENDPOINTS DEL DASHBOARD (requieren autenticación)
// =====================================================

// Historial de llamadas de un servicio
router.get('/calls/:clientServiceId', authenticate, clientOnly, voiceController.getCallHistory);

// Estadísticas de voz
router.get('/stats/:clientServiceId', authenticate, clientOnly, voiceController.getVoiceStats);

module.exports = router;
