const express = require('express');
const router = express.Router();
const oauthController = require('../controllers/oauthController');
const { authenticate, clientOnly } = require('../middlewares/auth');

// =====================================================
// RUTAS OAUTH - Meta (Facebook Login)
// =====================================================

// Iniciar flujo OAuth (requiere autenticación de cliente)
router.post('/meta/start', authenticate, clientOnly, oauthController.startOAuth);

// Callback de Facebook (público - Facebook redirige aquí)
router.get('/meta/callback', oauthController.handleCallback);

// Estado de conexión
router.get('/meta/status', authenticate, clientOnly, oauthController.getConnectionStatus);

// Desconectar OAuth
router.post('/meta/disconnect', authenticate, clientOnly, oauthController.disconnectOAuth);

// Seleccionar cuenta (cambiar página/número)
router.post('/meta/select-account', authenticate, clientOnly, oauthController.selectAccount);

// Listar cuentas disponibles
router.get('/meta/available-accounts', authenticate, clientOnly, oauthController.getAvailableAccounts);

// Renovar token antes de que expire
router.post('/meta/refresh-token', authenticate, clientOnly, oauthController.refreshToken);

// Debug: diagnosticar conexión OAuth (TEMPORAL)
router.get('/meta/debug-connection', authenticate, clientOnly, oauthController.debugConnection);

// Data Deletion Callback — requerido por Meta App Review
// URL a configurar en: Meta App Dashboard > Settings > Advanced > Data Deletion Instructions
// Formato: POST con signed_request como form-data
router.post('/meta/data-deletion', oauthController.metaDataDeletion);

module.exports = router;
