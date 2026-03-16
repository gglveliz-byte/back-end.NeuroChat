const { verifyAccessToken } = require('../utils/jwt');
const { query } = require('../config/database');

let ioInstance = null;

/**
 * Inicializar WebSocket con autenticación y manejo de salas
 */
function initializeWebSocket(io) {
  ioInstance = io;

  // Middleware de autenticación para Socket.io
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token) {
        // Permitir conexiones sin token para el widget público
        socket.userData = { type: 'guest' };
        return next();
      }

      const decoded = verifyAccessToken(token);
      if (!decoded) {
        return next(new Error('Token inválido'));
      }

      socket.userData = {
        id: decoded.id,
        type: decoded.type, // 'client' o 'admin'
        email: decoded.email
      };

      next();
    } catch (error) {
      // Permitir conexión pero sin datos de usuario
      socket.userData = { type: 'guest' };
      next();
    }
  });

  io.on('connection', (socket) => {
    // ===== UNIRSE A SALA DE SERVICIO =====
    // El cliente se une a una sala para recibir mensajes de ese servicio
    socket.on('join_service', async (data) => {
      try {
        const { clientId, serviceCode } = data;

        // Verificar que el usuario tiene acceso
        if (socket.userData?.type === 'client' && socket.userData.id !== clientId) {
          socket.emit('error', { message: 'No autorizado' });
          return;
        }

        const room = `service_${clientId}_${serviceCode}`;
        socket.join(room);

        // Enviar confirmación
        socket.emit('joined_service', { room, serviceCode });
      } catch (error) {
        console.error('Error en join_service:', error);
      }
    });

    // ===== SALIR DE SALA =====
    socket.on('leave_service', (data) => {
      const { clientId, serviceCode } = data;
      const room = `service_${clientId}_${serviceCode}`;
      socket.leave(room);
    });

    // ===== UNIRSE A CONVERSACIÓN ESPECÍFICA =====
    socket.on('join_conversation', (data) => {
      const { conversationId } = data;
      const room = `conversation_${conversationId}`;
      socket.join(room);
    });

    socket.on('leave_conversation', (data) => {
      const { conversationId } = data;
      socket.leave(`conversation_${conversationId}`);
    });

    // ===== TYPING INDICATOR =====
    socket.on('typing_start', (data) => {
      const { conversationId, senderType } = data;
      socket.to(`conversation_${conversationId}`).emit('typing', {
        conversationId,
        senderType: senderType || 'human',
        isTyping: true
      });
    });

    socket.on('typing_stop', (data) => {
      const { conversationId, senderType } = data;
      socket.to(`conversation_${conversationId}`).emit('typing', {
        conversationId,
        senderType: senderType || 'human',
        isTyping: false
      });
    });

    // ===== MARCAR COMO LEÍDO =====
    socket.on('mark_read', async (data) => {
      try {
        const { conversationId } = data;
        await query(
          'UPDATE conversations SET unread_count = 0 WHERE id = $1',
          [conversationId]
        );

        // Notificar a otros en la sala
        socket.to(`conversation_${conversationId}`).emit('messages_read', {
          conversationId
        });
      } catch (error) {
        console.error('Error en mark_read:', error);
      }
    });

    // ===== ADMIN: UNIRSE A PANEL GENERAL =====
    socket.on('join_admin', () => {
      if (socket.userData?.type === 'admin') {
        socket.join('admin_panel');
      }
    });

    // ===== WEBCHAT: UNIRSE A SESIÓN DE WIDGET =====
    socket.on('join_webchat', (data) => {
      const { conversationId } = data;
      socket.join(`webchat_${conversationId}`);
    });

    // ===== DESCONEXIÓN =====
    socket.on('disconnect', () => {
      // Limpiar todas las salas del socket para prevenir memory leaks
      const rooms = Array.from(socket.rooms);
      rooms.forEach(room => {
        if (room !== socket.id) {
          socket.leave(room);
        }
      });
    });
  });
}

// =====================================================
// FUNCIONES PARA EMITIR EVENTOS DESDE CUALQUIER PARTE
// =====================================================

/**
 * Emitir evento de nuevo mensaje entrante
 */
function emitNewMessage(clientId, serviceCode, data) {
  if (!ioInstance) return;

  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('new_message', data);

  // También emitir a la conversación específica
  if (data.conversationId) {
    ioInstance.to(`conversation_${data.conversationId}`).emit('new_message', data);
  }

  // Notificar al admin
  ioInstance.to('admin_panel').emit('new_message', {
    ...data,
    clientId,
    serviceCode
  });
}

/**
 * Emitir respuesta del bot
 */
function emitBotResponse(clientId, serviceCode, data) {
  if (!ioInstance) return;

  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('bot_response', data);

  if (data.conversationId) {
    ioInstance.to(`conversation_${data.conversationId}`).emit('bot_response', data);
    // Para el widget webchat
    ioInstance.to(`webchat_${data.conversationId}`).emit('bot_response', data);
  }
}

/**
 * Emitir nueva conversación
 */
function emitNewConversation(clientId, serviceCode, data) {
  if (!ioInstance) return;

  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('new_conversation', data);
  ioInstance.to('admin_panel').emit('new_conversation', { ...data, clientId, serviceCode });
}

/**
 * Emitir actualización de estado de mensaje
 */
function emitMessageStatus(conversationId, data) {
  if (!ioInstance) return;
  ioInstance.to(`conversation_${conversationId}`).emit('message_status', data);
}

/**
 * Emitir toggle de bot
 */
function emitBotToggle(clientId, serviceCode, data) {
  if (!ioInstance) return;
  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('bot_toggled', data);
}

/**
 * Emitir solicitud de atención humana detectada
 */
function emitHumanAttention(clientId, serviceCode, data) {
  if (!ioInstance) return;
  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('human_attention', data);
  ioInstance.to('admin_panel').emit('human_attention', { ...data, clientId, serviceCode });
}

/**
 * Emitir notificación de comprobante de pago recibido
 * Permite al panel del cliente ver al instante que un cliente envió su comprobante
 */
function emitOrderVoucherReceived(clientId, serviceCode, data) {
  if (!ioInstance) return;
  const room = `service_${clientId}_${serviceCode}`;
  ioInstance.to(room).emit('order_voucher_received', data);
}

/**
 * Obtener la instancia de io
 */
function getIO() {
  return ioInstance;
}

module.exports = {
  initializeWebSocket,
  emitNewMessage,
  emitBotResponse,
  emitNewConversation,
  emitMessageStatus,
  emitBotToggle,
  emitHumanAttention,
  emitOrderVoucherReceived,
  getIO
};
