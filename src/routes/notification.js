const express = require('express');
const router = express.Router();

const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../middlewares/auth');

router.get('/test', notificationController.testNotification);

// Todas las rutas requieren autenticación
router.use(authenticate);

/**
 * GET /notification
 * Listar últimas 50 notificaciones
 */
router.get('/', notificationController.getNotifications);

/**
 * GET /notification/unread-count
 * Obtener cantidad de no leídas
 */
router.get('/unread-count', notificationController.getUnreadCount);

/**
 * PATCH /notification/:id/read
 * Marcar una como leída
 */
router.patch('/:id/read', notificationController.markAsRead);

/**
 * PATCH /notification/read-all
 * Marcar todas como leídas
 */
router.patch('/read-all', notificationController.markAllAsRead);

/**
 * DELETE /notification/:id
 * Eliminar notificación
 */
router.delete('/:id', notificationController.deleteNotification);

module.exports = router;