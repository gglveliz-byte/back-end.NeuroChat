const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, adminOnly } = require('../middlewares/auth');

// Todas las rutas requieren autenticación de admin
router.use(authenticate, adminOnly);

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// Gestión de clientes
router.get('/clients', adminController.getClients);
router.get('/clients/:id', adminController.getClient);
router.post('/clients', adminController.createClient);
router.put('/clients/:id', adminController.updateClient);
router.delete('/clients/:id', adminController.deleteClient);

// Servicios de cliente
router.post('/clients/:clientId/services', adminController.assignService);
router.put('/clients/:clientId/services/:serviceId', adminController.updateClientService);
router.delete('/clients/:clientId/services/:serviceId', adminController.deleteClientService);

// Pagos
router.get('/payments', adminController.getPayments);
router.put('/payments/:id/validate', adminController.validatePayment);

// Trials
router.get('/trials', adminController.getTrials);
router.put('/trials/:id/extend', adminController.extendTrial);

// Servicios (catálogo)
router.get('/services', adminController.getServices);
router.put('/services/:id', adminController.updateService);

// Configuración del sistema
router.get('/config', adminController.getSystemConfig);
router.get('/config/bank', adminController.getBankDetails);
router.put('/config/bank', adminController.updateBankDetails);

// Configuración de Meta API
router.get('/config/meta', adminController.getMetaConfig);
router.put('/config/meta', adminController.updateMetaConfig);
router.post('/config/meta/test', adminController.testMetaConnection);

// Configuración de Telegram
router.get('/config/telegram', adminController.getTelegramConfig);
router.put('/config/telegram', adminController.updateTelegramConfig);
router.post('/config/telegram/test', adminController.testTelegramConnection);

// Proveedor de mensajería (meta | bird)
router.get('/config/messaging-provider', adminController.getMessagingProvider);
router.put('/config/messaging-provider', adminController.updateMessagingProvider);

// Pedidos (todas las órdenes)
router.get('/orders', adminController.getAllOrders);
router.put('/orders/:id/status', adminController.adminUpdateOrderStatus);

// CRON Jobs - Ejecución manual
// POST /api/v1/admin/jobs/:jobName
// jobNames: expireTrials, expireSubscriptions, notifyExpiringTrials, refreshTokens, cleanup
router.post('/jobs/:jobName', adminController.runCronJob);

// DEV / TEST — Conectar número de prueba de WhatsApp manualmente
router.post('/test/connect-whatsapp', adminController.testConnectWhatsApp);

// DEV / FIX — Actualizar un campo de platform_credentials (ej: instagram_account_id incorrecto)
router.post('/fix-platform-credential', adminController.fixPlatformCredential);

// =====================================================
// BILLING / PAYG
// =====================================================
router.get('/billing', adminController.getBillingOverview);
router.get('/billing/clients/:clientId', adminController.getClientBillingDetail);
router.post('/billing/credits/:clientServiceId', adminController.addClientCredits);
router.put('/billing/payg-pricing/:clientServiceId', adminController.updateServicePaygPricing);

// =====================================================
// VOZ IA — Solicitudes de activación de números
// =====================================================
router.get('/voice-requests', adminController.getVoiceRequests);
router.put('/voice-requests/:clientServiceId/activate', adminController.activateVoiceNumber);
router.put('/voice-requests/:clientServiceId/reject', adminController.rejectVoiceNumber);

module.exports = router;

