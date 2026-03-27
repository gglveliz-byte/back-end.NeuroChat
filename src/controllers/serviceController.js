const { query, transaction } = require('../config/database');
const { SERVICE_STATUS, SENDER_TYPES, MESSAGE_TYPES } = require('../config/constants');
const { emitNewMessage, emitBotToggle, emitHumanAttention } = require('../websocket/socketManager');
const metaService = require('../services/metaService');
const telegramService = require('../services/telegramService');
const pdfParse = require('pdf-parse');
const { sendVoiceActivationRequest } = require('../services/emailService');

// ==================== CONVERSACIONES ====================

const getConversations = async (req, res) => {
  try {
    const { code } = req.params;
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (page - 1) * limit;

    // Verificar que el cliente tiene el servicio
    const serviceCheck = await query(`
      SELECT cs.id, cs.status FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (serviceCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No tienes este servicio'
      });
    }

    const clientService = serviceCheck.rows[0];

    // Verificar estado del servicio
    if (clientService.status === SERVICE_STATUS.EXPIRED || clientService.status === SERVICE_STATUS.CANCELLED) {
      return res.status(403).json({
        success: false,
        error: 'Tu servicio está inactivo. Realiza un pago para reactivarlo.',
        code: 'SERVICE_INACTIVE'
      });
    }

    let whereClause = 'WHERE c.client_service_id = $1';
    const params = [clientService.id];
    let paramIndex = 2;

    if (status) {
      whereClause += ` AND c.status = $${paramIndex++}`;
      params.push(status);
    } else {
      whereClause += ` AND (c.status IS NULL OR c.status != 'archived')`;
    }

    if (search) {
      whereClause += ` AND (c.contact_name ILIKE $${paramIndex} OR c.contact_phone ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM conversations c ${whereClause}`,
      params
    );

    const conversationsResult = await query(`
      SELECT c.*,
             (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
             (SELECT sender_type FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_sender
      FROM conversations c
      ${whereClause}
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      data: {
        conversations: conversationsResult.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error en getConversations:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getConversation = async (req, res) => {
  try {
    const { code, conversationId } = req.params;

    // Verificar acceso
    const conversationResult = await query(`
      SELECT c.*, s.code as service_code
      FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    // Marcar como leída
    await query(
      'UPDATE conversations SET unread_count = 0 WHERE id = $1',
      [conversationId]
    );

    res.json({
      success: true,
      data: {
        conversation: conversationResult.rows[0]
      }
    });

  } catch (error) {
    console.error('Error en getConversation:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getMessages = async (req, res) => {
  try {
    const { code, conversationId } = req.params;
    const { page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;

    // Verificar acceso
    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    const countResult = await query(
      'SELECT COUNT(*) as total FROM messages WHERE conversation_id = $1',
      [conversationId]
    );

    const messagesResult = await query(`
      SELECT * FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT $2 OFFSET $3
    `, [conversationId, parseInt(limit), offset]);

    res.json({
      success: true,
      data: {
        messages: messagesResult.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error en getMessages:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { code, conversationId } = req.params;
    const { content, messageType = MESSAGE_TYPES.TEXT } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Contenido del mensaje requerido'
      });
    }

    // Verificar acceso y obtener configuración
    const conversationResult = await query(`
      SELECT c.*, cs.config, s.code as service_code
      FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    const conversation = conversationResult.rows[0];

    // Crear mensaje (intervención humana)
    const messageResult = await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING *
    `, [conversationId, SENDER_TYPES.HUMAN, content, messageType]);

    // Actualizar última actividad de la conversación
    await query(`
      UPDATE conversations
      SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [conversationId]);

    // Enviar mensaje a la plataforma correspondiente
    const savedMessage = messageResult.rows[0];
    const credentials = conversation.config?.platform_credentials || {};

    try {
      let sendResult;

      switch (code) {
        case 'whatsapp':
          if (credentials.phone_number_id) {
            sendResult = await metaService.sendWhatsAppTextWithToken(
              credentials.phone_number_id, conversation.contact_phone, content,
              credentials.whatsapp_access_token
            );
          }
          break;
        case 'messenger':
          if (credentials.page_access_token) {
            sendResult = await metaService.sendMessengerText(
              credentials.page_access_token, conversation.contact_id, content
            );
          }
          break;
        case 'instagram':
          if (credentials.instagram_access_token || credentials.page_access_token) {
            sendResult = await metaService.sendInstagramText(
              credentials.instagram_access_token || credentials.page_access_token,
              conversation.contact_id, content
            );
          }
          break;
        case 'telegram':
          const tgToken = telegramService.getGlobalBotToken();
          if (tgToken) {
            sendResult = await telegramService.sendTelegramText(
              tgToken, conversation.contact_id, content
            );
          }
          break;
        // webchat no necesita envío externo
      }

      if (sendResult?.success) {
        await query('UPDATE messages SET status = $1, external_id = $2 WHERE id = $3',
          ['sent', sendResult.messageId || null, savedMessage.id]);
        savedMessage.status = 'sent';
      }
    } catch (sendError) {
      console.error('Error enviando mensaje a plataforma:', sendError.message);
      await query('UPDATE messages SET status = $1 WHERE id = $2', ['failed', savedMessage.id]);
      savedMessage.status = 'failed';
    }

    // Emitir evento WebSocket
    emitNewMessage(req.user.id, code, {
      conversationId,
      message: savedMessage,
      platform: code,
      senderType: 'human'
    });

    res.status(201).json({
      success: true,
      message: 'Mensaje enviado',
      data: {
        message: messageResult.rows[0]
      }
    });

  } catch (error) {
    console.error('Error en sendMessage:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const toggleBot = async (req, res) => {
  try {
    const { code, conversationId } = req.params;
    const { active } = req.body;

    // Verificar acceso
    const accessCheck = await query(`
      SELECT c.id, c.is_bot_active FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    const newState = active !== undefined ? active : !accessCheck.rows[0].is_bot_active;

    await query(
      'UPDATE conversations SET is_bot_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newState, conversationId]
    );

    // Emitir evento WebSocket
    emitBotToggle(req.user.id, code, {
      conversationId,
      is_bot_active: newState
    });

    res.json({
      success: true,
      message: newState ? 'Bot activado' : 'Bot desactivado (control manual)',
      data: {
        is_bot_active: newState
      }
    });

  } catch (error) {
    console.error('Error en toggleBot:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const markAttended = async (req, res) => {
  try {
    const { code, conversationId } = req.params;

    // Verificar acceso
    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Conversación no encontrada'
      });
    }

    await query(
      'UPDATE conversations SET needs_human_attention = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [conversationId]
    );

    // Emitir evento WebSocket para que otros tabs/sesiones actualicen en tiempo real
    emitHumanAttention(req.user.id, code, {
      conversationId,
      needs_human_attention: false,
      attended: true
    });

    res.json({
      success: true,
      message: 'Conversación marcada como atendida'
    });

  } catch (error) {
    console.error('Error en markAttended:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== ACCIONES DE CONVERSACIÓN (Archivar / Vaciar / Eliminar / Etiquetas) ====================

const deleteConversation = async (req, res) => {
  try {
    const { code, conversationId } = req.params;

    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    await query("DELETE FROM conversations WHERE id = $1", [conversationId]);

    res.json({ success: true, message: 'Conversación eliminada permanentemente' });
  } catch (error) {
    console.error('Error en deleteConversation:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const updateConversationTags = async (req, res) => {
  try {
    const { code, conversationId } = req.params;
    const { tags } = req.body;

    if (!Array.isArray(tags)) {
      return res.status(400).json({ success: false, error: 'Las etiquetas deben ser un array' });
    }

    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    await query(
      "UPDATE conversations SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [JSON.stringify(tags), conversationId]
    );

    res.json({ success: true, message: 'Etiquetas actualizadas', data: { tags } });
  } catch (error) {
    console.error('Error en updateConversationTags:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const archiveConversation = async (req, res) => {
  try {
    const { code, conversationId } = req.params;

    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    await query(
      "UPDATE conversations SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [conversationId]
    );

    res.json({ success: true, message: 'Conversación archivada exitosamente' });
  } catch (error) {
    console.error('Error en archiveConversation:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const clearMessages = async (req, res) => {
  try {
    const { code, conversationId } = req.params;

    const accessCheck = await query(`
      SELECT c.id FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.id = $1 AND cs.client_id = $2 AND s.code = $3
    `, [conversationId, req.user.id, code]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    await query("DELETE FROM messages WHERE conversation_id = $1", [conversationId]);
    await query("UPDATE conversations SET last_message_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversationId]);

    res.json({ success: true, message: 'Chat vaciado exitosamente' });
  } catch (error) {
    console.error('Error en clearMessages:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ==================== CONFIGURACIÓN DEL BOT ====================

const getBotConfig = async (req, res) => {
  try {
    const { code } = req.params;

    const result = await query(`
      SELECT bc.*, cs.config as platform_credentials, s.name as service_name, s.code as service_code
      FROM bot_configs bc
      JOIN client_services cs ON bc.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Configuración no encontrada'
      });
    }

    const configData = result.rows[0];
    // Añadir platform_credentials al objeto config
    configData.platform_credentials = configData.platform_credentials || {};

    res.json({
      success: true,
      data: {
        config: configData
      }
    });

  } catch (error) {
    console.error('Error en getBotConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateBotConfig = async (req, res) => {
  try {
    const { code } = req.params;
    const { config } = req.body;

    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'Configuración requerida'
      });
    }

    // Obtener client_service_id
    const csResult = await query(`
      SELECT cs.id FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const clientServiceId = csResult.rows[0].id;

    // Verificar si existe el bot_config
    const existingConfig = await query(
      'SELECT id FROM bot_configs WHERE client_service_id = $1',
      [clientServiceId]
    );

    if (existingConfig.rows.length === 0) {
      // Crear nuevo bot_config
      await query(`
        INSERT INTO bot_configs (
          client_service_id,
          welcome_message,
          away_message,
          fallback_message,
          personality,
          language,
          business_hours,
          ai_config,
          knowledge_base,
          payment_config,
          quick_replies,
          advanced_config
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        clientServiceId,
        config.welcome_message || '¡Hola! 👋 Bienvenido/a. Soy tu asistente virtual y estoy aquí para ayudarte con todo lo que necesites. ¿Qué estás buscando hoy? 😊',
        config.away_message || 'Actualmente estamos fuera del horario de atención. Te responderemos lo antes posible.',
        config.fallback_message || 'Disculpa, no entendí tu mensaje. ¿Podrías reformularlo o ser más específico?',
        config.personality || 'friendly',
        config.language || 'es',
        JSON.stringify(config.business_hours || {}),
        JSON.stringify(config.ai_config || { model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 500 }),
        typeof config.knowledge_base === 'string'
          ? config.knowledge_base
          : JSON.stringify(config.knowledge_base || {}),
        JSON.stringify(config.payment_config || {}),
        JSON.stringify(config.quick_replies || []),
        JSON.stringify(config.advanced_config || {})
      ]);
    } else {
      // Actualizar bot_config existente
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (config.welcome_message !== undefined) {
        updates.push(`welcome_message = $${paramIndex++}`);
        values.push(config.welcome_message);
      }
      if (config.away_message !== undefined) {
        updates.push(`away_message = $${paramIndex++}`);
        values.push(config.away_message);
      }
      if (config.fallback_message !== undefined) {
        updates.push(`fallback_message = $${paramIndex++}`);
        values.push(config.fallback_message);
      }
      if (config.personality !== undefined) {
        updates.push(`personality = $${paramIndex++}`);
        values.push(config.personality);
      }
      if (config.language !== undefined) {
        updates.push(`language = $${paramIndex++}`);
        values.push(config.language);
      }
      if (config.business_hours !== undefined) {
        updates.push(`business_hours = $${paramIndex++}`);
        values.push(JSON.stringify(config.business_hours));
      }
      if (config.ai_config !== undefined) {
        updates.push(`ai_config = $${paramIndex++}`);
        values.push(JSON.stringify(config.ai_config));
      }
      if (config.knowledge_base !== undefined) {
        updates.push(`knowledge_base = $${paramIndex++}`);
        values.push(typeof config.knowledge_base === 'string'
          ? config.knowledge_base
          : JSON.stringify(config.knowledge_base));
      }
      if (config.payment_config !== undefined) {
        updates.push(`payment_config = $${paramIndex++}`);
        values.push(JSON.stringify(config.payment_config));
      }
      if (config.quick_replies !== undefined) {
        updates.push(`quick_replies = $${paramIndex++}`);
        values.push(JSON.stringify(config.quick_replies));
      }
      if (config.advanced_config !== undefined) {
        updates.push(`advanced_config = $${paramIndex++}`);
        values.push(JSON.stringify(config.advanced_config));
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(clientServiceId);

        await query(
          `UPDATE bot_configs SET ${updates.join(', ')} WHERE client_service_id = $${paramIndex}`,
          values
        );
      }
    }

    // Guardar platform_credentials en client_services.config
    // Se envuelve en { platform_credentials: {...} } para que el webhook
    // pueda buscar con config->'platform_credentials'->>'phone_number_id'
    if (config.platform_credentials) {
      // Obtener config existente para no sobreescribir otros campos
      const existingConfigResult = await query(
        'SELECT config FROM client_services WHERE id = $1',
        [clientServiceId]
      );
      const existingConfig = existingConfigResult.rows[0]?.config || {};
      const mergedConfig = {
        ...existingConfig,
        platform_credentials: config.platform_credentials
      };

      await query(
        `UPDATE client_services SET config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(mergedConfig), clientServiceId]
      );
    }

    res.json({
      success: true,
      message: 'Configuración actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error en updateBotConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== ESTADÍSTICAS ====================

const getStats = async (req, res) => {
  try {
    const { code } = req.params;
    const { period = '7d' } = req.query;

    // Calcular fecha de inicio según período
    let intervalClause = "INTERVAL '7 days'";
    if (period === '30d') intervalClause = "INTERVAL '30 days'";
    if (period === '90d') intervalClause = "INTERVAL '90 days'";

    // Obtener client_service_id
    const csResult = await query(`
      SELECT cs.id FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const clientServiceId = csResult.rows[0].id;

    // Total de conversaciones
    const totalConversationsResult = await query(
      'SELECT COUNT(*) as total FROM conversations WHERE client_service_id = $1',
      [clientServiceId]
    );

    // Conversaciones en el período
    const periodConversationsResult = await query(`
      SELECT COUNT(*) as total FROM conversations
      WHERE client_service_id = $1 AND created_at >= CURRENT_TIMESTAMP - ${intervalClause}
    `, [clientServiceId]);

    // Total de mensajes
    const totalMessagesResult = await query(`
      SELECT COUNT(*) as total FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.client_service_id = $1
    `, [clientServiceId]);

    // Mensajes en el período
    const periodMessagesResult = await query(`
      SELECT COUNT(*) as total FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.client_service_id = $1 AND m.created_at >= CURRENT_TIMESTAMP - ${intervalClause}
    `, [clientServiceId]);

    // Mensajes por tipo de remitente
    const messagesBySenderResult = await query(`
      SELECT m.sender_type, COUNT(*) as total FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.client_service_id = $1 AND m.created_at >= CURRENT_TIMESTAMP - ${intervalClause}
      GROUP BY m.sender_type
    `, [clientServiceId]);

    // Conversaciones activas (con mensajes en las últimas 24h)
    const activeConversationsResult = await query(`
      SELECT COUNT(*) as total FROM conversations
      WHERE client_service_id = $1 AND last_message_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
    `, [clientServiceId]);

    // Intervenciones humanas
    const humanInterventionsResult = await query(`
      SELECT COUNT(*) as total FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.client_service_id = $1 AND m.sender_type = 'human'
      AND m.created_at >= CURRENT_TIMESTAMP - ${intervalClause}
    `, [clientServiceId]);

    // Mensajes por día (últimos 7 días)
    const messagesPerDayResult = await query(`
      SELECT DATE(m.created_at) as date, COUNT(*) as total
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.client_service_id = $1 AND m.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
      GROUP BY DATE(m.created_at)
      ORDER BY date ASC
    `, [clientServiceId]);

    res.json({
      success: true,
      data: {
        overview: {
          totalConversations: parseInt(totalConversationsResult.rows[0].total),
          periodConversations: parseInt(periodConversationsResult.rows[0].total),
          totalMessages: parseInt(totalMessagesResult.rows[0].total),
          periodMessages: parseInt(periodMessagesResult.rows[0].total),
          activeConversations: parseInt(activeConversationsResult.rows[0].total),
          humanInterventions: parseInt(humanInterventionsResult.rows[0].total)
        },
        messagesBySender: messagesBySenderResult.rows.reduce((acc, row) => {
          acc[row.sender_type] = parseInt(row.total);
          return acc;
        }, {}),
        messagesPerDay: messagesPerDayResult.rows
      }
    });

  } catch (error) {
    console.error('Error en getStats:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== KNOWLEDGE FILES ====================

// ==================== TELEGRAM STATUS ====================

const getTelegramStatus = async (req, res) => {
  try {
    const { code } = req.params;

    // Verificar que el servicio existe y pertenece al cliente
    const csResult = await query(`
      SELECT cs.id, cs.status FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const clientServiceId = csResult.rows[0].id;

    // Obtener info del bot global
    const botInfo = await telegramService.getGlobalBotInfo();

    if (!botInfo) {
      return res.json({
        success: true,
        data: {
          configured: false,
          bot_username: null,
          bot_link: null,
          message: 'Telegram no esta configurado en la plataforma. Contacta al administrador.'
        }
      });
    }

    // El deep link unico para este cliente
    const deepLink = `https://t.me/${botInfo.username}?start=${clientServiceId}`;

    res.json({
      success: true,
      data: {
        configured: true,
        bot_username: botInfo.username,
        bot_first_name: botInfo.first_name,
        bot_link: deepLink,
        client_service_id: clientServiceId
      }
    });

  } catch (error) {
    console.error('Error en getTelegramStatus:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== DIAGNOSTIC ====================

const getDiagnostic = async (req, res) => {
  try {
    const { code } = req.params;
    const clientId = req.user.id;

    // Obtener servicio del cliente
    const serviceResult = await query(`
      SELECT cs.id, cs.status, cs.config, cs.token_expires_at, cs.token_status,
             s.code as service_code, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, code]);

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const service = serviceResult.rows[0];
    const config = service.config || {};
    const creds = config.platform_credentials || {};

    // Obtener estadísticas de conversaciones
    const convsResult = await query(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
             COUNT(CASE WHEN is_bot_active = true THEN 1 END) as bot_active
      FROM conversations WHERE client_service_id = $1
    `, [service.id]);

    const stats = convsResult.rows[0];

    // Información específica por plataforma
    let platformInfo = {};

    if (code === 'instagram') {
      platformInfo = {
        page_id: creds.page_id || null,
        page_name: creds.page_name || null,
        instagram_account_id: creds.instagram_account_id || null,
        instagram_username: creds.instagram_username || null,
        webhook_subscribed: creds.webhook_subscribed || false,

        // Diagnóstico
        has_instagram_connected: !!creds.instagram_account_id,
        has_page_token: !!creds.page_access_token,
        oauth_completed: config.oauth_connected === true
      };
    } else if (code === 'whatsapp') {
      platformInfo = {
        waba_id: creds.waba_id || null,
        waba_name: creds.waba_name || null,
        phone_number_id: creds.phone_number_id || null,
        display_phone: creds.display_phone || null,
        verified_name: creds.verified_name || null,
        webhook_subscribed: creds.webhook_subscribed || false,

        // Diagnóstico
        has_phone_configured: !!creds.phone_number_id,
        has_whatsapp_token: !!creds.whatsapp_access_token,
        oauth_completed: config.oauth_connected === true
      };
    } else if (code === 'messenger') {
      platformInfo = {
        page_id: creds.page_id || null,
        page_name: creds.page_name || null,
        webhook_subscribed: creds.webhook_subscribed || false,

        // Diagnóstico
        has_page_token: !!creds.page_access_token,
        oauth_completed: config.oauth_connected === true
      };
    }

    res.json({
      success: true,
      data: {
        service: {
          code: service.service_code,
          name: service.service_name,
          status: service.status,
          token_status: service.token_status,
          token_expires_at: service.token_expires_at,
          oauth_connected: config.oauth_connected || false,
          oauth_connected_at: config.oauth_connected_at || null
        },
        platform: platformInfo,
        stats: {
          total_conversations: parseInt(stats.total),
          active_conversations: parseInt(stats.active),
          bot_active_conversations: parseInt(stats.bot_active)
        },
        recommendations: generateRecommendations(code, config, creds, stats)
      }
    });

  } catch (error) {
    console.error('Error en getDiagnostic:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

function generateRecommendations(code, config, creds, stats) {
  const recommendations = [];

  if (!config.oauth_connected) {
    recommendations.push({
      type: 'error',
      message: `No has conectado tu cuenta de ${code}. Ve a "Vincular Cuentas" para conectar.`
    });
  }

  if (code === 'instagram') {
    if (!creds.instagram_account_id) {
      recommendations.push({
        type: 'error',
        message: 'No se detectó cuenta de Instagram vinculada. Asegúrate de que tu Página de Facebook tenga una cuenta de Instagram Business conectada en Meta Business Suite.'
      });
    }

    if (!creds.webhook_subscribed) {
      recommendations.push({
        type: 'warning',
        message: 'Los webhooks no están suscritos. Ve a Meta for Developers → Webhooks → Instagram y suscríbete al campo "messages".'
      });
    }

    if (creds.instagram_account_id && parseInt(stats.total) === 0) {
      recommendations.push({
        type: 'info',
        message: 'Todo está configurado correctamente. Envía un mensaje a tu cuenta de Instagram para probar.'
      });
    }
  }

  if (code === 'whatsapp') {
    if (!creds.phone_number_id) {
      recommendations.push({
        type: 'error',
        message: 'No se detectó número de WhatsApp. Completa el flujo OAuth para configurar tu WhatsApp Business.'
      });
    }
  }

  if (code === 'messenger') {
    if (!creds.page_id) {
      recommendations.push({
        type: 'error',
        message: 'No se detectó Página de Facebook. Completa el flujo OAuth para conectar tu página.'
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      type: 'success',
      message: '¡Todo configurado correctamente! Tu bot está listo para recibir mensajes.'
    });
  }

  return recommendations;
}

// ==================== VOZ IA CONFIG ====================

const getVoiceConfig = async (req, res) => {
  try {
    const { code } = req.params;

    const result = await query(`
      SELECT cs.id, cs.config->'voice_config' AS voice_config
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
      LIMIT 1
    `, [req.user.id, code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const voiceConfig = result.rows[0].voice_config || {
      enabled: false,
      voice: 'nova',
      max_duration_seconds: 600,
      transfer_phone: '',
      transfer_phone_backup: '',
      welcome_message: '',
      whatsapp_phone: '',
      language: 'es',
    };

    return res.json({ success: true, data: voiceConfig });
  } catch (err) {
    console.error('[getVoiceConfig] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al obtener configuración de voz' });
  }
};

const updateVoiceConfig = async (req, res) => {
  try {
    const { code } = req.params;
    const {
      whatsapp_phone,
      transfer_phone,
      transfer_phone_backup,
      voice,
      max_duration_seconds,
      welcome_message,
      language,
      timeout_message,
      out_of_hours_message,
    } = req.body;

    if (!whatsapp_phone || whatsapp_phone.trim().length < 7) {
      return res.status(400).json({ success: false, error: 'Ingresa un número de WhatsApp válido' });
    }

    // Verificar que el servicio pertenece al cliente
    const serviceCheck = await query(`
      SELECT cs.id, cs.config, cs.plan_type,
             c.name AS client_name, c.email AS client_email,
             b.name AS business_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      JOIN clients c ON c.id = cs.client_id
      LEFT JOIN businesses b ON b.client_id = cs.client_id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (serviceCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const row = serviceCheck.rows[0];
    const clientServiceId = row.id;
    const existingConfig = row.config || {};
    const existingVoice = existingConfig.voice_config || {};

    // Determinar si es una nueva solicitud o actualización
    const isNewRequest = !existingVoice.whatsapp_phone ||
      existingVoice.whatsapp_phone !== whatsapp_phone.trim() ||
      existingVoice.voice_status === 'inactive';

    const voiceConfig = {
      whatsapp_phone: whatsapp_phone.trim(),
      transfer_phone: transfer_phone || '',
      transfer_phone_backup: transfer_phone_backup || '',
      voice: voice || 'nova',
      max_duration_seconds: parseInt(max_duration_seconds) || 600,
      welcome_message: welcome_message || '',
      language: language || 'es',
      timeout_message: timeout_message || '',
      out_of_hours_message: out_of_hours_message || '',
      // Status: si ya estaba activo y no cambió el número, mantener activo
      voice_status: isNewRequest ? 'pending' : (existingVoice.voice_status || 'pending'),
      enabled: existingVoice.voice_status === 'active',
    };

    await query(`
      UPDATE client_services
      SET config = jsonb_set(COALESCE(config, '{}'), '{voice_config}', $1::jsonb),
          updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(voiceConfig), clientServiceId]);

    // Si es solicitud nueva → notificar al admin por email
    if (isNewRequest) {
      setImmediate(() => {
        sendVoiceActivationRequest({
          clientName: row.client_name,
          businessName: row.business_name,
          whatsappPhone: whatsapp_phone.trim(),
          plan: row.plan_type,
        }).catch(() => { });
      });
    }

    const message = isNewRequest
      ? 'Solicitud enviada. El equipo de NeuroChat activará tu número en breve.'
      : 'Configuración actualizada correctamente.';

    return res.json({ success: true, message, data: voiceConfig });
  } catch (err) {
    console.error('[updateVoiceConfig] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al guardar la configuración' });
  }
};

// ==================== GLOBAL CONFIG (read-only para clientes) ====================

const getMessagingProvider = async (req, res) => {
  try {
    const result = await query(
      `SELECT value FROM system_config WHERE key = 'messaging_provider'`
    );
    const provider = result.rows[0]?.value?.replace(/"/g, '') || 'meta';
    return res.json({ success: true, data: { provider } });
  } catch (err) {
    console.error('[getMessagingProvider] Error:', err);
    return res.json({ success: true, data: { provider: 'meta' } });
  }
};

// ==================== BIRD CHANNEL ====================

const getBirdChannel = async (req, res) => {
  const { code } = req.params;
  try {
    const result = await query(`
      SELECT cs.config
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const { config } = result.rows[0];
    const isBirdConnected = config?.provider === 'bird' && !!config?.bird_channel_id;

    return res.json({
      success: true,
      data: {
        connected: isBirdConnected,
        channelId: isBirdConnected ? config.bird_channel_id : null,
      }
    });
  } catch (err) {
    console.error('[getBirdChannel] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al obtener estado de Bird' });
  }
};

const saveBirdChannel = async (req, res) => {
  const { code } = req.params;
  const { channelId } = req.body;

  if (!channelId || typeof channelId !== 'string' || channelId.trim().length < 3) {
    return res.status(400).json({ success: false, error: 'channelId es requerido' });
  }

  const trimmedId = channelId.trim();
  try {
    const result = await query(`
      UPDATE client_services
      SET
        config = COALESCE(config, '{}'::jsonb) || $1::jsonb,
        platform_account_id = $2
      WHERE id = (
        SELECT cs.id FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        WHERE cs.client_id = $3 AND s.code = $4
        LIMIT 1
      )
      RETURNING id
    `, [
      JSON.stringify({ provider: 'bird', bird_channel_id: trimmedId }),
      trimmedId,
      req.user.id,
      code,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    return res.json({ success: true, data: { channelId: trimmedId } });
  } catch (err) {
    console.error('[saveBirdChannel] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al guardar el canal de Bird' });
  }
};

const disconnectBirdChannel = async (req, res) => {
  const { code } = req.params;
  try {
    const result = await query(`
      UPDATE client_services
      SET
        config = ((COALESCE(config, '{}'::jsonb) - 'provider') - 'bird_channel_id'),
        platform_account_id = NULL
      WHERE id = (
        SELECT cs.id FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        WHERE cs.client_id = $1 AND s.code = $2
        LIMIT 1
      )
      RETURNING id
    `, [req.user.id, code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[disconnectBirdChannel] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al desconectar el canal de Bird' });
  }
};

module.exports = {
  getConversations,
  getConversation,
  getMessages,
  sendMessage,
  toggleBot,
  markAttended,
  getBotConfig,
  updateBotConfig,
  getStats,
  getTelegramStatus,
  getDiagnostic,
  getVoiceConfig,
  updateVoiceConfig,
  archiveConversation,
  deleteConversation,
  clearMessages,
  updateConversationTags,
  getMessagingProvider,
  getBirdChannel,
  saveBirdChannel,
  disconnectBirdChannel,
};
