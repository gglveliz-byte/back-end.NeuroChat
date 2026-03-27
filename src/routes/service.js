const express = require('express');
const router = express.Router();
const serviceController = require('../controllers/serviceController');
const { authenticate, clientOnly } = require('../middlewares/auth');

// Todas las rutas requieren autenticación de cliente
router.use(authenticate, clientOnly);

// Config global (accesible por clientes — no requiere :code)
router.get('/config/messaging-provider', serviceController.getMessagingProvider);

// Conversaciones
router.get('/:code/conversations', serviceController.getConversations);
router.get('/:code/conversations/:conversationId', serviceController.getConversation);
router.get('/:code/conversations/:conversationId/messages', serviceController.getMessages);
router.post('/:code/conversations/:conversationId/messages', serviceController.sendMessage);
router.put('/:code/conversations/:conversationId/bot', serviceController.toggleBot);
router.put('/:code/conversations/:conversationId/attended', serviceController.markAttended);
router.put('/:code/conversations/:conversationId/archive', serviceController.archiveConversation);
router.delete('/:code/conversations/:conversationId', serviceController.deleteConversation);
router.delete('/:code/conversations/:conversationId/messages', serviceController.clearMessages);
router.put('/:code/conversations/:conversationId/tags', serviceController.updateConversationTags);

// Configuración del bot
router.get('/:code/config', serviceController.getBotConfig);
router.put('/:code/config', serviceController.updateBotConfig);

// Estadísticas
router.get('/:code/stats', serviceController.getStats);

// Telegram status (deep link)
router.get('/:code/telegram-status', serviceController.getTelegramStatus);

// Instagram diagnostic
router.get('/:code/diagnostic', serviceController.getDiagnostic);

// Voz IA — configuración
router.get('/:code/voice-config', serviceController.getVoiceConfig);
router.put('/:code/voice-config', serviceController.updateVoiceConfig);

// Bird channel (conexión manual sin Meta OAuth)
router.get('/:code/bird-channel', serviceController.getBirdChannel);
router.post('/:code/bird-channel', serviceController.saveBirdChannel);
router.delete('/:code/bird-channel', serviceController.disconnectBirdChannel);

module.exports = router;
