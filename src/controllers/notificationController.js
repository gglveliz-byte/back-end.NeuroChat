const notificationService = require('../services/notificationService');
const { NotificationRecipientTypes } = require('../enums/notificationTypes');

const testNotification = async (req,res) => {
  try {
    setImmediate(() => {
      const notificationService = require('../services/notificationService');

      notificationService.createNotification({
        recipient_type: NotificationRecipientTypes.ADMIN,   // NotificationRecipientTypes.CLIENT, ADMIN, B2B
        recipient_id: 'admin-env',//'94167d0e-3922-45a3-8bc0-2539938f1e2c', // ID del usuario que recibirá la notificación // admin-env
        type: 'test', // NotificationTypes.PAYMENT_CONFIRMED
        title: 'Titulo de notificación 1',
        body: 'Breve descripción de una notificación',
        path: '/client/orders', // Para que el frontend sepa a dónde ir al hacer click,
        data: { orderId: '12345' } // Datos adicionales que el frontend puede usar
      });
    });

    res.json({
      success: true,
      message: 'Notificación enviada'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Error' });
  }
};

/**
 * Obtener notificaciones
 */
const getNotifications = async (req, res) => {
  try {
    const { sub: recipient_id, type: recipient_type } = req.user;
    const notifications = await notificationService.getNotifications(recipient_id, recipient_type);

    res.json(notifications);
  } catch (error) {
    console.error('Error getting notifications:', error);
    res.status(500).json({ message: 'Error getting notifications' });
  }
};

/**
 * Contador de no leídas
 */
const getUnreadCount = async (req, res) => {
  try {
    const { sub: recipient_id, type: recipient_type } = req.user;

    const count = await notificationService.getUnreadCount(recipient_id, recipient_type);

    res.json({ count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ message: 'Error getting unread count' });
  }
};

/**
 * Marcar una como leída
 */
const markAsRead = async (req, res) => {
  try {
    const { id: notificationId } = req.params;
    const { id: userId } = req.user;

    await notificationService.markAsRead(notificationId, userId);

    res.json({ message: 'Notificación marcada como leída' });
  } catch (error) {
    console.error('Error marking as read:', error);
    res.status(500).json({ message: 'Error marking notification' });
  }
};

/**
 * Marcar todas como leídas
 */
const markAllAsRead = async (req, res) => {
  try {
    const { id, type } = req.user;

    await notificationService.markAllAsRead(id, type);

    res.json({ message: 'Todas las notificaciones marcadas como leídas' });
  } catch (error) {
    console.error('Error marking all as read:', error);
    res.status(500).json({ message: 'Error marking all as read' });
  }
};

/**
 * Eliminar notificación
 */
const deleteNotification = async (req, res) => {
  try {
    const { id: notificationId } = req.params;
    const { id: userId } = req.user;

    await notificationService.deleteNotification(notificationId, userId);

    res.json({ message: 'Notificación eliminada' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Error deleting notification' });
  }
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  testNotification
};