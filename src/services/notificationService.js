const { query } = require('../config/database');
const { emitNotification } = require('../websocket/socketManager');

/**
 * Crear una notificación
 */
const createNotification = async ({
  recipient_type,
  recipient_id,
  type,
  title,
  body,
  path,
  data
}) => {
  try {
    // 1. Guardar en DB
    const result = await query(
      `
      INSERT INTO notifications 
      (recipient_type, recipient_id, type, title, body, data, path)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [recipient_type, recipient_id, type, title, body, data, path]
    );

    const notification = result.rows[0];

    notification.path = path; // Agregar path al objeto que se emitirá, aunque no se guarde en DB

    // 2. Emitir por Socket.IO
    emitNotification(
      recipient_type,
      recipient_id,
      notification
    );

    return notification;

  } catch (error) {
    console.error('Error creating notification:', error);
  }
};

/**
 * Marcar una como leída
 */
const markAsRead = async (notificationId, recipient_id) => {
  return query(
    `
    UPDATE notifications 
    SET read = true 
    WHERE id = $1 AND recipient_id = $2
    `,
    [notificationId, recipient_id]
  );
};

/**
 * Marcar todas como leídas
 */
const markAllAsRead = async (recipient_id, recipient_type) => {
  return query(
    `
    UPDATE notifications 
    SET read = true 
    WHERE recipient_id = $1 AND recipient_type = $2
    `,
    [recipient_id, recipient_type]
  );
};

/**
 * Obtener notificaciones
 */
const getNotifications = async (recipient_id, recipient_type) => {
  const result = await query(
    `
    SELECT * 
    FROM notifications
    WHERE recipient_id = $1 
      AND recipient_type = $2
    ORDER BY created_at DESC
    LIMIT 50
    `,
    [recipient_id, recipient_type]
  );

  return result.rows;
};

/**
 * Obtener no leídas (para contador)
 */
const getUnreadCount = async (recipient_id, recipient_type) => {
  const result = await query(
    `
    SELECT COUNT(*) 
    FROM notifications
    WHERE recipient_id = $1 
      AND recipient_type = $2
      AND read = false
    `,
    [recipient_id, recipient_type]
  );

  return parseInt(result.rows[0].count, 10);
};

/**
 * Eliminar notificación
 */
const deleteNotification = async (notificationId, recipient_id) => {
  return query(
    `
    DELETE FROM notifications
    WHERE id = $1 AND recipient_id = $2
    `,
    [notificationId, recipient_id]
  );
};

module.exports = {
  createNotification,
  markAsRead,
  markAllAsRead,
  getNotifications,
  getUnreadCount,
  deleteNotification
};