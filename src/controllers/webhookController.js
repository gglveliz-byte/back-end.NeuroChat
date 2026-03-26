const axios = require('axios');
const { query, transaction } = require('../config/database');
const { SENDER_TYPES, MESSAGE_TYPES, MESSAGE_STATUS } = require('../config/constants');
const { generateResponse, detectIntent, analyzeSentiment } = require('../services/openaiService');
const { downloadWhatsAppMedia } = require('../services/metaService');
const { uploadFromBase64 } = require('../services/cloudinaryService');
const metaService = require('../services/metaService');
const telegramService = require('../services/telegramService');
const birdService = require('../services/birdService');
const { emitNewMessage, emitBotResponse, emitNewConversation, emitHumanAttention } = require('../websocket/socketManager');
const { checkMessageLimit, incrementMessageCount, checkConversationLimit, incrementConversationCount, atomicCheckAndIncrementService, atomicCheckAndIncrementConversation } = require('../services/messageLimitService');
const { sendDailyLimitReachedEmail, sendHumanAttentionEmail, sendSubscriptionExpiredEmail } = require('../services/emailService');
const { recordTokenUsage, processPaygResponse, checkBalance } = require('../services/billingService');
const { transcribeAudio, downloadTelegramAudio, downloadAudioFromUrl } = require('../services/audioService');
const { PAYG } = require('../config/constants');
const { NotificationRecipientTypes, NotificationTypes } = require('../enums/notificationTypes');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/**
 * Obtiene el nombre del usuario desde Facebook/Instagram Graph API
 * Solo se llama cuando el webhook no trae el nombre (ej: Messenger)
 */
async function fetchUserNameFromMeta(userId, pageAccessToken) {
  try {
    const res = await axios.get(`${GRAPH_API}/${userId}`, {
      params: { fields: 'name', access_token: pageAccessToken },
      timeout: 5000
    });
    return res.data?.name || null;
  } catch {
    return null;
  }
}

// =====================================================
// HELPER: Verificar horario de atención
// =====================================================
function isWithinBusinessHours(botConfig) {
  if (!botConfig?.business_hours) return true;

  let businessHours;
  try {
    businessHours = typeof botConfig.business_hours === 'string'
      ? JSON.parse(botConfig.business_hours)
      : botConfig.business_hours;
  } catch {
    return true; // Si no se puede parsear, asumir que está disponible
  }

  if (!businessHours.enabled) return true;

  const now = new Date();
  const timezone = businessHours.timezone || 'America/Bogota';

  // Obtener hora actual en la zona horaria del negocio
  let localTime;
  try {
    localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  } catch {
    localTime = now;
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDay = dayNames[localTime.getDay()];
  const schedule = businessHours.schedule?.[currentDay];

  if (!schedule || !schedule.enabled) return false;

  const currentMinutes = localTime.getHours() * 60 + localTime.getMinutes();
  const [openH, openM] = (schedule.open || '09:00').split(':').map(Number);
  const [closeH, closeM] = (schedule.close || '18:00').split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
}

// =====================================================
// HELPER: Verificar límite de mensajes (trial y pagados)
// =====================================================
// Usa el nuevo servicio de límites que maneja:
// - Trial: 100 mensajes/día
// - Pagados: 2000 mensajes/día
async function checkTrialLimit(clientServiceId) {
  // Usar el nuevo servicio de límites
  return await checkMessageLimit(clientServiceId);
}

// =====================================================
// HELPER: Verificar si trial o suscripción han expirado
// Retorna true si expiró (y marca como 'expired' + envía email)
// =====================================================
async function checkAndHandleExpiration(serviceData) {
  const now = new Date();
  const isTrialExpired = serviceData.status === 'trial' &&
    serviceData.trial_ends_at && new Date(serviceData.trial_ends_at) <= now;
  const isSubscriptionExpired = serviceData.status === 'active' &&
    serviceData.subscription_ends_at && new Date(serviceData.subscription_ends_at) <= now;

  if (!isTrialExpired && !isSubscriptionExpired) return false;

  // Marcar como expirado en DB (síncrono para que se refleje antes de procesar mensaje)
  try {
    const updated = await query(`
      UPDATE client_services
      SET status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status IN ('trial', 'active')
      RETURNING id
    `, [serviceData.client_service_id]);

    // Email de notificación (no bloqueante — OK si falla el email)
    if (updated.rows.length > 0 && serviceData.client_email) {
      sendSubscriptionExpiredEmail(
        serviceData.client_email,
        serviceData.client_name,
        serviceData.service_name,
        20
      ).catch(err => console.error('Error enviando email de expiración:', err.message));
      try {
        notificationService.createNotification({
          recipient_type: NotificationRecipientTypes.CLIENT,
          recipient_id: serviceData.client_id,
          type: NotificationTypes.SUBSCRIPTION_EXPIRED,
          title: '¡Suscripción!',
          body: `Tu suscripción de ${serviceData.service_name} ha expirado.`,
          path: 'client/services',
          data: serviceData
        });
      } catch (error) {
        console.error(`❌ Error al crear notificación ${NotificationTypes.SUBSCRIPTION_EXPIRED}:`, error);
      }
    }
  } catch (err) {
    console.error('Error marcando servicio como expirado:', err.message);
  }

  return true; // Está expirado — no procesar mensaje
}

// =====================================================
// HELPER: Buscar client_service por credenciales de plataforma
// =====================================================
async function findClientServiceByPlatformId(platform, platformAccountId) {
  if (!platformAccountId) return null;

  // Buscar en la columna config JSONB de client_services
  // Las credenciales se guardan en config.platform_credentials
  let searchQuery;

  switch (platform) {
    case 'whatsapp':
      // Buscar por phone_number_id
      searchQuery = `
        SELECT cs.id as client_service_id, cs.status, cs.config, cs.plan_type,
               cs.trial_ends_at, cs.subscription_ends_at,
               s.code as service_code, s.name as service_name,
               b.id as business_id, b.name as business_name, b.industry, b.description,
               b.website, b.country, b.address, b.phone as business_phone, b.email as business_email,
               b.business_hours, b.payment_config,
               c.id as client_id, c.name as client_name, c.email as client_email
        FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        JOIN clients c ON cs.client_id = c.id
        JOIN businesses b ON c.id = b.client_id
        WHERE s.code = 'whatsapp'
          AND cs.status IN ('active', 'trial')
          AND (
            cs.config->'platform_credentials'->>'phone_number_id' = $1
            OR cs.config->'api_credentials'->>'phone_number_id' = $1
          )
        LIMIT 1
      `;
      break;

    case 'messenger':
      // Buscar primero en servicios messenger; si no hay, luego en instagram
      // (las páginas conectadas a Instagram también reciben eventos page de Messenger)
      searchQuery = `
        SELECT cs.id as client_service_id, cs.status, cs.config, cs.plan_type,
               cs.trial_ends_at, cs.subscription_ends_at,
               s.code as service_code, s.name as service_name,
               b.id as business_id, b.name as business_name, b.industry, b.description,
               b.website, b.country, b.address, b.phone as business_phone, b.email as business_email, b.slug,
               b.business_hours, b.payment_config,
               c.id as client_id, c.name as client_name, c.email as client_email
        FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        JOIN clients c ON cs.client_id = c.id
        JOIN businesses b ON c.id = b.client_id
        WHERE s.code IN ('messenger', 'instagram')
          AND cs.status IN ('active', 'trial')
          AND (
            cs.config->'platform_credentials'->>'page_id' = $1
            OR cs.config->'api_credentials'->>'page_id' = $1
          )
        ORDER BY CASE WHEN s.code = 'messenger' THEN 0 ELSE 1 END
        LIMIT 1
      `;
      break;

    case 'instagram':
      searchQuery = `
        SELECT cs.id as client_service_id, cs.status, cs.config, cs.plan_type,
               cs.trial_ends_at, cs.subscription_ends_at,
               s.code as service_code, s.name as service_name,
               b.id as business_id, b.name as business_name, b.industry, b.description,
               b.website, b.country, b.address, b.phone as business_phone, b.email as business_email, b.slug,
               b.business_hours, b.payment_config,
               c.id as client_id, c.name as client_name, c.email as client_email
        FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        JOIN clients c ON cs.client_id = c.id
        JOIN businesses b ON c.id = b.client_id
        WHERE s.code = 'instagram'
          AND cs.status IN ('active', 'trial')
          AND (
            cs.config->'platform_credentials'->>'instagram_account_id' = $1
            OR cs.config->'platform_credentials'->>'page_id' = $1
            OR cs.config->'api_credentials'->>'instagram_account_id' = $1
          )
        LIMIT 1
      `;
      break;

    default:
      return null;
  }

  const result = await query(searchQuery, [platformAccountId]);
  return result.rows.length > 0 ? result.rows[0] : null;
}

// =====================================================
// HELPER: Limpiar texto para TTS (quitar emojis, markdown, spanglish)
// =====================================================
function cleanTextForTTS(text) {
  return text
    .replace(/\[SPLIT\]/g, '. ')
    // Reemplazar términos técnicos ingleses por fonética en español
    .replace(/\bWhatsApp\b/gi, 'Watsap')
    .replace(/\bchatbots?\b/gi, (m) => m.endsWith('s') ? 'asistentes virtuales' : 'asistente virtual')
    .replace(/\bbots?\b/gi, (m) => m.endsWith('s') ? 'asistentes' : 'asistente')
    .replace(/\bonline\b/gi, 'en línea')
    .replace(/\bSaaS\b/g, '')
    .replace(/\bMessenger\b/gi, 'Mesényer')
    // Limpiar markdown
    .replace(/\*+([^*]+)\*+/g, '$1')
    .replace(/#{1,6}\s/g, '')
    // Quitar emojis y caracteres no pronunciables
    .replace(/[^\p{L}\p{N}\p{P}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// =====================================================
// HELPER: Generar respuesta del bot y enviarla
// =====================================================
async function generateAndSendBotResponse({
  conversationId, clientServiceId, serviceData, platform,
  contactId, contactPhone, messageContent, messageId, mediaId, wasAudio = false,
  birdConversationId = undefined
}) {
  // Obtener configuración del bot
  const botConfigResult = await query(
    'SELECT * FROM bot_configs WHERE client_service_id = $1',
    [clientServiceId]
  );
  const botConfig = botConfigResult.rows[0] || {};

  // Verificar horario de atención — prioridad: businesses.business_hours > bot_configs.business_hours
  const hoursSource = (serviceData.business_hours && Object.keys(serviceData.business_hours).length > 0)
    ? serviceData
    : botConfig;
  if (!isWithinBusinessHours(hoursSource)) {
    const awayMsg = botConfig.away_message || 'Estamos fuera del horario de atención. Te responderemos pronto.';
    const awayResult = await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, $2, $3, 'text', 'pending') RETURNING *
    `, [conversationId, SENDER_TYPES.BOT, awayMsg]);

    // Intentar enviar mensaje de ausencia
    await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, awayMsg, messageId);

    return { response: awayMsg, isAway: true };
  }

  // 1. Verificar+incrementar límite por conversación de forma ATÓMICA (evita race condition)
  const conversationLimitCheck = await atomicCheckAndIncrementConversation(conversationId);
  if (!conversationLimitCheck.allowed) {
    const maintenanceMsg = 'El asistente virtual se encuentra en mantenimiento. Te pondremos en contacto con un agente personal.';
    await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, $2, $3, 'text', 'pending') RETURNING *
    `, [conversationId, SENDER_TYPES.BOT, maintenanceMsg]);

    await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, maintenanceMsg, messageId);

    return { response: maintenanceMsg, isConversationLimit: true };
  }

  // 2. Verificar+incrementar límite del servicio de forma ATÓMICA (trial: 100/día, pagados: 2000/día)
  const serviceLimitCheck = await atomicCheckAndIncrementService(clientServiceId);
  if (!serviceLimitCheck.allowed) {
    const maintenanceMsg = 'El asistente virtual se encuentra en mantenimiento. Te pondremos en contacto con un agente personal.';
    await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, $2, $3, 'text', 'pending') RETURNING *
    `, [conversationId, SENDER_TYPES.BOT, maintenanceMsg]);

    await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, maintenanceMsg, messageId);

    // Enviar email al cliente notificando que alcanzó su límite
    const clientInfo = await query(
      'SELECT c.email, c.name, s.name as service_name FROM clients c JOIN client_services cs ON c.id = cs.client_id JOIN services s ON cs.service_id = s.id WHERE cs.id = $1',
      [clientServiceId]
    );
    if (clientInfo.rows.length > 0) {
      const { email, name, service_name } = clientInfo.rows[0];
      sendDailyLimitReachedEmail(
        email,
        name,
        service_name,
        serviceLimitCheck.limit,
        serviceLimitCheck.status
      ).catch(err => console.error('Error enviando email de límite:', err));
      try {
        notificationService.createNotification({
          recipient_type: NotificationRecipientTypes.CLIENT,
          recipient_id: serviceData.client_id,
          type: NotificationTypes.SEND_DAILY_LIMIT_REACHED,
          title: '¡Límite de Mensajes Alcanzado!',
          body: `Tu servicio ${service_name} ha alcanzado el límite de mensajes diario.`,
          path: 'client/services',
          data: clientInfo.rows[0]
        });
      } catch (error) {
        console.error(`❌ Error al crear notificación ${NotificationTypes.SEND_DAILY_LIMIT_REACHED}:`, error);
      }
    }

    return { response: maintenanceMsg, isServiceLimit: true };
  }

  // 3. Detectar intención y Handover
  let intent = 'OTRO';
  try {
    intent = await detectIntent(messageContent);
  } catch (e) { console.error('Error detectando intención:', e); }

  // Verificar si se requiere handover
  if (intent === 'CONTACTO_HUMANO' && botConfig.enable_auto_handover) {

    // Marcar conversación
    await query(`
      UPDATE conversations 
      SET needs_human_attention = true, is_bot_active = false 
      WHERE id = $1
    `, [conversationId]);

    const handoverMsg = botConfig.handover_message ||
      'Estás siendo transferido a un asesor humano. En breve te atenderemos. 👤';

    // Guardar respuesta
    const botMsgResult = await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, $2, $3, 'text', 'pending') RETURNING *
    `, [conversationId, SENDER_TYPES.BOT, handoverMsg]);

    const botMessage = botMsgResult.rows[0];

    // Enviar a plataforma
    const sendResult = await sendBotMessageToPlatform(
      platform, serviceData, contactId, contactPhone, handoverMsg, messageId
    );

    // Actualizar estado msg
    if (sendResult?.success) {
      await query(
        `UPDATE messages SET status = 'sent', external_id = $1 WHERE id = $2`,
        [sendResult.messageId || null, botMessage.id]
      );
    } else {
      await query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [botMessage.id]);
    }

    // Notificar al dashboard (WebSocket)
    emitBotResponse(serviceData.client_id, serviceData.service_code, {
      conversationId,
      message: botMessage,
      platform,
      needsHumanAttention: true
    });

    // Emitir evento dedicado de atención humana
    emitHumanAttention(serviceData.client_id, serviceData.service_code, {
      conversationId,
      contactName: contactId,
      platform
    });

    // Notificar al cliente por email
    const clientInfo = await query(
      'SELECT c.email, c.name FROM clients c JOIN client_services cs ON c.id = cs.client_id WHERE cs.id = $1',
      [clientServiceId]
    );
    if (clientInfo.rows.length > 0) {
      const { email, name } = clientInfo.rows[0];
      sendHumanAttentionEmail(email, name, {
        contactName: contactId,
        platform,
        conversationId
      }).catch(err => console.error('Error enviando email de atención humana:', err));
      try {
        notificationService.createNotification({
          recipient_type: NotificationRecipientTypes.CLIENT,
          recipient_id: serviceData.client_id,
          type: NotificationTypes.SEND_HUMAN_ATTENTION,
          title: '¡Atención Humana Requerida!',
          body: `Un cliente necesita hablar contigo en ${platform} ahora mismo.`,
          path: '',
          data: clientInfo.rows[0]
        });
      } catch (error) {
        console.error(`❌ Error al crear notificación ${NotificationTypes.SEND_HUMAN_ATTENTION}:`, error);
      }
    }

    return { response: handoverMsg, isHandover: true };
  }

  // Obtener historial de mensajes (30 mensajes para mejor contexto)
  const historyResult = await query(`
    SELECT sender_type, content FROM messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC LIMIT 30
  `, [conversationId]);
  const messageHistory = historyResult.rows.reverse();

  // Detectar si es el primer mensaje real del usuario (conversación nueva)
  const userMessagesInHistory = messageHistory.filter(m => m.sender_type === 'contact');
  const isNewConversation = userMessagesInHistory.length === 0;

  // Info del negocio
  const businessInfo = {
    name: serviceData.business_name,
    industry: serviceData.industry,
    description: serviceData.description,
    website: serviceData.website,
    address: serviceData.address,
    phone: serviceData.business_phone,
    email: serviceData.business_email
  };

  // Parsear config de IA
  let aiConfig = {};
  if (botConfig.ai_config) {
    try {
      aiConfig = typeof botConfig.ai_config === 'string'
        ? JSON.parse(botConfig.ai_config) : botConfig.ai_config;
    } catch { /* usar defaults */ }
  }

  // Obtener archivos de conocimiento (globales por cliente)
  let knowledgeFiles = [];
  try {
    const kfResult = await query(
      'SELECT filename, extracted_text FROM client_knowledge_files WHERE client_id = $1',
      [serviceData.client_id]
    );
    knowledgeFiles = kfResult.rows;
  } catch { /* ignorar si la tabla no existe aún */ }

  // Download image if mediaId present (for voucher validation via Vision API)
  let imageUrl = null;
  if (mediaId && platform === 'whatsapp') {
    try {
      const creds = serviceData.config?.platform_credentials || serviceData.config?.api_credentials || {};
      const downloadResult = await downloadWhatsAppMedia(mediaId, creds.access_token || creds.accessToken);
      if (downloadResult.success) {
        imageUrl = downloadResult.dataUrl;
      }
    } catch (imgErr) {
      console.error('Error descargando imagen WhatsApp:', imgErr.message);
    }
  }

  const planType = serviceData.plan_type || 'pro';

  // Para PAYG: verificar saldo antes de llamar a la IA
  if (planType === PAYG.PLAN_TYPE) {
    const balanceInfo = await checkBalance(clientServiceId);
    if (balanceInfo.isEmpty) {
      const botMsgResult = await query(`
        INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
        VALUES ($1, $2, $3, 'text', 'sent') RETURNING *
      `, [conversationId, SENDER_TYPES.BOT, PAYG.ZERO_BALANCE_RESPONSE]);
      const botMessage = botMsgResult.rows[0];
      await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, PAYG.ZERO_BALANCE_RESPONSE, messageId);
      emitBotResponse(serviceData.client_id, serviceData.service_code, { conversationId, message: botMessage, platform });
      return { response: PAYG.ZERO_BALANCE_RESPONSE, botMessage, sendResult: null };
    }
  }

  // Generar respuesta con IA
  // Parse payment_config — desde businesses (global) con fallback a bot_configs (legacy)
  let paymentConfig = {};
  try {
    const raw = serviceData.payment_config || botConfig.payment_config;
    paymentConfig = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch { /* usar defaults */ }

  const { content: responseText, usage, productImages = [] } = await generateResponse({
    userMessage: messageContent,
    messageHistory,
    botConfig: {
      personality: botConfig.personality || 'amable y profesional',
      language: botConfig.language || 'español',
      instructions: botConfig.knowledge_base || '',
      fallbackMessage: botConfig.fallback_message,
      model: aiConfig.model || 'gpt-4o-mini',
      temperature: aiConfig.temperature || 0.7,
      maxTokens: aiConfig.max_tokens || 350,
      knowledgeFiles,
      paymentConfig
    },
    businessInfo,
    clientId: serviceData.client_id,
    conversationId,
    planType,
    imageUrl,
    isNewConversation
  });

  // Guardar respuesta del bot (guardar texto limpio sin marcadores [SPLIT])
  const cleanResponseText = responseText.replace(/\[SPLIT\]/g, ' ').trim();
  const botMsgResult = await query(`
    INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
    VALUES ($1, $2, $3, 'text', 'pending') RETURNING *
  `, [conversationId, SENDER_TYPES.BOT, cleanResponseText]);

  const botMessage = botMsgResult.rows[0];

  // Billing: record token usage for all plans + deduct credits for PAYG (síncrono para no perder cobros)
  try {
    if (planType === PAYG.PLAN_TYPE) {
      const paygPricing = serviceData.config?.payg_pricing || null;
      await processPaygResponse({
        clientId: serviceData.client_id,
        clientServiceId,
        conversationId,
        messageId: botMessage.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        provider: usage.provider,
        model: usage.model,
        paygPricing,
      });
    } else if (usage.totalTokens > 0) {
      await recordTokenUsage({
        clientId: serviceData.client_id,
        clientServiceId,
        conversationId,
        messageId: botMessage.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        provider: usage.provider,
        model: usage.model,
        planType,
      });
    }
  } catch (billingErr) {
    console.error('[Billing] Error recording usage:', billingErr.message);
  }

  // Auto-handover para plan Basic: si el bot pidió transferencia, marcar la conversación
  if (planType === 'basic') {
    const handoverKeywords = ['transferirte', 'asesor personal', 'agente humano', 'equipo de ventas', 'en breve te contactarán'];
    const needsHandover = handoverKeywords.some(keyword => responseText.toLowerCase().includes(keyword.toLowerCase()));
    if (needsHandover) {
      await query(`
        UPDATE conversations
        SET needs_human_attention = true, is_bot_active = false
        WHERE id = $1
      `, [conversationId]);

      // Emitir evento WebSocket de atención humana
      emitHumanAttention(serviceData.client_id, serviceData.service_code, {
        conversationId,
        contactName: contactId,
        platform
      });

      // Notificar al cliente por email
      const clientInfoBasic = await query(
        'SELECT c.email, c.name FROM clients c JOIN client_services cs ON c.id = cs.client_id WHERE cs.id = $1',
        [clientServiceId]
      );
      if (clientInfoBasic.rows.length > 0) {
        const { email, name } = clientInfoBasic.rows[0];
        sendHumanAttentionEmail(email, name, {
          contactName: contactId,
          platform,
          conversationId
        }).catch(err => console.error('Error enviando email de atención humana (basic):', err));
        try {
          notificationService.createNotification({
            recipient_type: NotificationRecipientTypes.CLIENT,
            recipient_id: serviceData.client_id,
            type: NotificationTypes.SEND_HUMAN_ATTENTION,
            title: '¡Atención Humana Requerida!',
            body: `Un cliente necesita hablar contigo en ${platform} ahora mismo.`,
            path: '',
            data: clientInfoBasic.rows[0]
          });
        } catch (error) {
          console.error(`❌ Error al crear notificación ${NotificationTypes.SEND_HUMAN_ATTENTION}:`, error);
        }
      }
    }
  }

  // Voucher save: if we had an image and the AI responded about a voucher, upload to Cloudinary & save on order
  if (imageUrl) {
    try {
      const voucherKeywords = ['comprobante', 'voucher', 'recibido', 'pago', 'orden'];
      const mentionsVoucher = voucherKeywords.some(k => responseText.toLowerCase().includes(k));
      if (mentionsVoucher) {
        // Find the most recent pending order in this conversation
        const pendingOrder = await query(`
          SELECT id FROM orders
          WHERE conversation_id = $1 AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `, [conversationId]);

        if (pendingOrder.rows.length > 0) {
          // Upload voucher image to Cloudinary
          let voucherCloudUrl = imageUrl; // fallback to base64 if upload fails
          try {
            const uploaded = await uploadFromBase64(imageUrl, 'vouchers');
            voucherCloudUrl = uploaded.url;
          } catch (cloudErr) {
            console.error('Error subiendo comprobante a Cloudinary:', cloudErr.message);
          }

          await query(`
            UPDATE orders SET voucher_url = $1, status = 'paid_voucher', updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [voucherCloudUrl, pendingOrder.rows[0].id]);
        }
      }
    } catch (voucherErr) {
      console.error('Error guardando comprobante:', voucherErr.message);
    }
  }

  // Enviar a la plataforma
  // Si el usuario mandó audio (wasAudio) en WhatsApp → responder con nota de voz (ahora limitado al 30% de las veces por costos operativos)
  // El texto se guarda en DB para el panel del admin
  let sendResult;

  const shouldMirrorAudio = wasAudio && platform === 'whatsapp' && Math.random() < 0.30;

  if (shouldMirrorAudio) {
    sendResult = await sendBotVoiceNoteToPlatform(serviceData, contactPhone, cleanResponseText, messageId);
    if (!sendResult.success) {
      // Fallback: si TTS falla, enviar texto normal
      console.warn('[TTS] Fallback a texto por error en audio');
      sendResult = await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, responseText, messageId, { birdConversationId });
    }
  } else {
    sendResult = await sendBotMessageToPlatform(
      platform, serviceData, contactId, contactPhone, responseText, messageId, { birdConversationId }
    );
  }

  // Actualizar estado del mensaje
  if (sendResult?.success) {
    await query(
      `UPDATE messages SET status = 'sent', external_id = $1 WHERE id = $2`,
      [sendResult.messageId || null, botMessage.id]
    );

    // Enviar imágenes de productos (si la IA consultó el catálogo)
    // Se envían siempre — incluso en modo audio-a-audio — para que el cliente vea las fotos
    if (productImages.length > 0) {
      const imagesToSend = productImages.slice(0, 3);
      for (const img of imagesToSend) {
        if (!img.url) continue;
        await new Promise(r => setTimeout(r, 800)); // pausa entre imagen y la anterior
        await sendBotImageToPlatform(platform, serviceData, contactId, contactPhone, img.url, img.caption, { birdConversationId }).catch(() => { });
      }
    }
  } else {
    await query(
      `UPDATE messages SET status = 'failed' WHERE id = $1`,
      [botMessage.id]
    );
  }

  // Emitir evento WebSocket de respuesta del bot
  emitBotResponse(serviceData.client_id, serviceData.service_code, {
    conversationId,
    message: botMessage,
    platform
  });

  return { response: responseText, botMessage, sendResult, productImages };
}

// =====================================================
// HELPER: Llamar a ElevenLabs TTS — devuelve Buffer de audio o null si falla
// =====================================================
async function callElevenLabsTTS(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica multilingual
  try {
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: text.substring(0, 400),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true }
      },
      {
        headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': key },
        responseType: 'arraybuffer',
        timeout: 15000
      }
    );
    return Buffer.from(resp.data);
  } catch (err) {
    const msg = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
    console.error('[ElevenLabs] Error:', msg);
    return null;
  }
}

// =====================================================
// HELPER: Responder con nota de voz cuando usuario manda audio (audio-to-audio)
// =====================================================
async function sendBotVoiceNoteToPlatform(serviceData, contactPhone, text, originalMsgId) {
  const credentials = serviceData.config?.platform_credentials || serviceData.config?.api_credentials || {};
  const phoneNumberId = credentials.phone_number_id;
  const accessToken = credentials.whatsapp_access_token;
  if (!phoneNumberId || !accessToken) return { success: false };

  if (originalMsgId) {
    metaService.markWhatsAppAsReadWithToken(phoneNumberId, originalMsgId, accessToken).catch(() => { });
  }

  const ttsText = cleanTextForTTS(text);
  if (!ttsText || ttsText.length < 3) return { success: false };

  const audioBuffer = await callElevenLabsTTS(ttsText);
  if (!audioBuffer) return { success: false };

  const result = await metaService.sendWhatsAppAudio(phoneNumberId, contactPhone, audioBuffer, accessToken);
  if (result.success) console.log(`[ElevenLabs] Nota de voz enviada — ${ttsText.length} chars`);
  return result;
}

// =====================================================
// HELPER: Dividir respuesta en partes para envío natural (estilo humano)
// Respeta [SPLIT] del AI; si no hay marcadores, divide automáticamente.
// =====================================================
function smartSplitResponse(text) {
  // Si el AI ya usó [SPLIT], respetar esos cortes
  if (text.includes('[SPLIT]')) {
    return text.split('[SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
  }

  // Dividir por párrafos dobles (saltos de línea vacíos)
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);

  if (paragraphs.length > 1) {
    // Cada párrafo va separado (son bloques distintos del AI)
    // Solo juntar si ambos son muy cortos (< 15 palabras en total)
    const result = [];
    let current = '';
    for (const para of paragraphs) {
      if (!current) {
        current = para;
      } else {
        const combined = current + '\n\n' + para;
        if (combined.split(/\s+/).length > 30) {
          result.push(current);
          current = para;
        } else {
          current = combined;
        }
      }
    }
    if (current) result.push(current);
    return result;
  }

  // Párrafo único largo → dividir por oraciones (. ! ?)
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 25) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
  const result = [];
  let current = '';
  for (const sent of sentences) {
    if (!current) {
      current = sent;
    } else {
      const combined = current + ' ' + sent;
      if (combined.split(/\s+/).length > 22) {
        result.push(current.trim());
        current = sent;
      } else {
        current = combined;
      }
    }
  }
  if (current.trim()) result.push(current.trim());
  return result.length > 0 ? result : [text];
}

// =====================================================
// HELPER: Enviar mensaje del bot a la plataforma
// Divide en múltiples mensajes con delays y typing indicator
// =====================================================
async function sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, message, originalMsgId, extraParams = {}) {
  try {
    const credentials = serviceData.config?.platform_credentials || serviceData.config?.api_credentials || {};

    // Si el servicio usa Bird como proveedor, redirigir a Bird independientemente del canal
    if (serviceData.config?.provider === 'bird') {
      platform = 'bird';
    }

    // Dividir respuesta en partes naturales
    const parts = smartSplitResponse(message);

    // Delay helper
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Calcular delay de escritura (simula velocidad humana)
    const typingDelay = (text) => Math.min(3000, Math.max(800, text.split(/\s+/).length * 80));

    let lastResult = { success: false };

    switch (platform) {
      case 'whatsapp': {
        const phoneNumberId = credentials.phone_number_id;
        const accessToken = credentials.whatsapp_access_token;
        if (!phoneNumberId || !accessToken) {
          console.error('WhatsApp: credenciales no encontradas en config del cliente');
          return { success: false };
        }

        // Marcar el mensaje original como leído de inmediato (muestra ticks azules)
        if (originalMsgId) {
          metaService.markWhatsAppAsReadWithToken(phoneNumberId, originalMsgId, accessToken).catch(() => { });
        }

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const wordCount = part.split(/\s+/).length;

          // Esperar como si estuviera escribiendo
          await sleep(typingDelay(part));

          // Voice notes opcionales: solo si el cliente lo habilitó en su config
          const voiceNotesEnabled = serviceData.config?.voice_notes_enabled === true;
          if (voiceNotesEnabled && wordCount <= 12 && Math.random() < 0.10 && process.env.ELEVENLABS_API_KEY) {
            const cleaned = cleanTextForTTS(part);
            const audioBuffer = await callElevenLabsTTS(cleaned);
            if (audioBuffer) {
              const audioRes = await metaService.sendWhatsAppAudio(phoneNumberId, contactPhone, audioBuffer, accessToken);
              if (audioRes.success) {
                lastResult = audioRes;
                if (i < parts.length - 1) await sleep(600);
                continue;
              }
            }
          }

          // Enviar como texto (default o fallback si audio falla)
          lastResult = await metaService.sendWhatsAppTextWithToken(phoneNumberId, contactPhone, part, accessToken);
          if (i < parts.length - 1) await sleep(500);
        }
        return lastResult;
      }

      case 'messenger': {
        const pageAccessToken = credentials.page_access_token;
        if (!pageAccessToken) {
          console.error('Messenger: page_access_token no encontrado en config del cliente');
          return { success: false };
        }
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          await metaService.sendMessengerTypingIndicator(pageAccessToken, contactId, 'typing_on').catch(() => { });
          await sleep(typingDelay(part));
          lastResult = await metaService.sendMessengerText(pageAccessToken, contactId, part);
          if (i < parts.length - 1) {
            await metaService.sendMessengerTypingIndicator(pageAccessToken, contactId, 'typing_off').catch(() => { });
            await sleep(400);
          }
        }
        return lastResult;
      }

      case 'instagram': {
        const igAccessToken = credentials.instagram_access_token || credentials.page_access_token;
        if (!igAccessToken) {
          console.error('Instagram: access_token no encontrado en config del cliente');
          return { success: false };
        }
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          await metaService.sendMessengerTypingIndicator(igAccessToken, contactId, 'typing_on').catch(() => { });
          await sleep(typingDelay(part));
          lastResult = await metaService.sendInstagramText(igAccessToken, contactId, part);
          if (i < parts.length - 1) {
            await metaService.sendMessengerTypingIndicator(igAccessToken, contactId, 'typing_off').catch(() => { });
            await sleep(400);
          }
        }
        return lastResult;
      }

      case 'telegram': {
        const botToken = telegramService.getGlobalBotToken();
        if (!botToken) {
          console.error('Telegram: bot token no encontrado');
          return { success: false };
        }
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          // Typing indicator de Telegram
          await telegramService.markTelegramAsRead(botToken, contactId).catch(() => { });
          await sleep(typingDelay(part));
          const opts = i === 0 && originalMsgId ? { reply_to_message_id: parseInt(originalMsgId, 10) || undefined } : {};
          lastResult = await telegramService.sendTelegramText(botToken, contactId, part, opts);
          if (i < parts.length - 1) await sleep(400);
        }
        return lastResult;
      }

      case 'bird': {
        const { birdConversationId } = extraParams;
        if (!birdConversationId) {
          console.error('[Bird] birdConversationId no disponible — no se puede enviar respuesta');
          return { success: false };
        }
        for (let i = 0; i < parts.length; i++) {
          await sleep(typingDelay(parts[i]));
          lastResult = await birdService.sendBirdText(birdConversationId, parts[i]);
          if (i < parts.length - 1) await sleep(400);
        }
        return lastResult;
      }

      default:
        return { success: false, error: 'Plataforma no soportada para envío' };
    }
  } catch (error) {
    console.error(`Error enviando mensaje a ${platform}:`, error.message);
    return { success: false, error: error.message };
  }
}

// =====================================================
// HELPER: Enviar imagen del producto a la plataforma
// =====================================================
async function sendBotImageToPlatform(platform, serviceData, contactId, contactPhone, imageUrl, caption, extraParams = {}) {
  const credentials = serviceData.config?.platform_credentials || serviceData.config?.api_credentials || {};

  // Si el servicio usa Bird, redirigir envío de imagen a Bird
  if (serviceData.config?.provider === 'bird') {
    platform = 'bird';
  }

  try {
    switch (platform) {
      case 'whatsapp': {
        const phoneNumberId = credentials.phone_number_id;
        const accessToken = credentials.whatsapp_access_token;
        if (!phoneNumberId || !accessToken) return;
        await metaService.sendWhatsAppImage(phoneNumberId, contactPhone, imageUrl, caption || '', accessToken);
        break;
      }
      case 'messenger': {
        const token = credentials.page_access_token;
        if (!token) return;
        await metaService.sendMessengerImage(token, contactId, imageUrl);
        break;
      }
      case 'instagram': {
        const token = credentials.instagram_access_token || credentials.page_access_token;
        if (!token) return;
        await metaService.sendInstagramImage(token, contactId, imageUrl);
        break;
      }
      case 'telegram': {
        const botToken = telegramService.getGlobalBotToken();
        if (!botToken) return;
        await telegramService.sendTelegramPhoto(botToken, contactId, imageUrl, caption || '');
        break;
      }
      case 'bird': {
        const { birdConversationId } = extraParams;
        if (birdConversationId) {
          await birdService.sendBirdImage(birdConversationId, imageUrl, caption || '');
        }
        break;
      }
      // webchat: las imágenes se incluyen en la respuesta JSON
      default:
        break;
    }
  } catch (err) {
    console.error(`Error enviando imagen de producto a ${platform}:`, err.message);
  }
}

// =====================================================
// PRINCIPAL: Procesar mensaje desde webhook de Meta
// Esta función es llamada DESPUÉS de responder 200 a Meta
// =====================================================
const processWebhookMessage = async (data) => {
  let {
    platform, platformAccountId, contactId, contactName,
    contactPhone, message, messageType, messageId, timestamp,
    mediaId, audioId, audioMimeType, audioUrl, birdConversationId
  } = data;

  // ─── TRANSCRIPCIÓN DE AUDIO CON OPENAI WHISPER ───
  // Si el mensaje es un audio, transcribirlo antes de continuar.
  let wasAudio = false; // Flag para modo audio-to-audio
  if (messageType === 'audio' || audioId || audioUrl) {
    wasAudio = true;
    try {
      let audioBuffer = null;
      let detectedMime = audioMimeType || 'audio/ogg';

      if (audioId && platform === 'whatsapp') {
        // WhatsApp: descargar via Graph API — necesitamos el token del cliente
        const svcForAudio = await findClientServiceByPlatformId(platform, platformAccountId);
        if (svcForAudio) {
          const audioCreds = svcForAudio.config?.platform_credentials || svcForAudio.config?.api_credentials || {};
          // El campo correcto es whatsapp_access_token
          const token = audioCreds.whatsapp_access_token || audioCreds.access_token || audioCreds.accessToken;
          if (token) {
            const dlResult = await downloadWhatsAppMedia(audioId, token);
            if (dlResult.success) {
              const base64Data = dlResult.dataUrl.split(',')[1];
              audioBuffer = Buffer.from(base64Data, 'base64');
              detectedMime = dlResult.mimeType || detectedMime;
            } else {
              console.error('[Audio] downloadWhatsAppMedia falló:', dlResult.error);
            }
          } else {
            console.error('[Audio] whatsapp_access_token no encontrado en config');
          }
        }
      } else if (audioUrl) {
        // Messenger / Instagram: URL directa
        const dl = await downloadAudioFromUrl(audioUrl);
        audioBuffer = dl.buffer;
        detectedMime = dl.mimeType;
      }

      if (audioBuffer) {
        const transcription = await transcribeAudio(audioBuffer, detectedMime);
        if (transcription) {
          message = `🎤 ${transcription}`;
          messageType = 'text';
          console.log(`[Audio→Texto] ${platform}: "${transcription.substring(0, 100)}"`);
        } else {
          console.warn('[Audio] Transcripción vacía');
          wasAudio = false; // No activar audio-to-audio si no se pudo transcribir
        }
      }
    } catch (audioErr) {
      console.error('[Audio] Error transcribiendo audio:', audioErr.message);
      wasAudio = false;
    }
  }

  // ─── DEDUPLICACIÓN: El ON CONFLICT (external_id) en el INSERT de mensajes
  // es el guard real y atómico. No hacemos SELECT previo (race condition).

  // 1. Buscar client_service por ID de plataforma
  const serviceData = await findClientServiceByPlatformId(platform, platformAccountId);

  if (!serviceData) {
    console.warn(`⚠️  Sin servicio ${platform} para ID: ${platformAccountId} — ignorando`);
    return;
  }

  // Si se buscó messenger pero el servicio encontrado es instagram, significa que
  // la página está conectada solo a Instagram (no Messenger): ignorar silenciosamente
  if (platform === 'messenger' && serviceData.service_code === 'instagram') {
    return;
  }

  // 2. Verificar que el servicio esté activo
  if (serviceData.status !== 'active' && serviceData.status !== 'trial') {
    return;
  }

  // 3. Verificar expiración de trial o suscripción
  const isExpired = await checkAndHandleExpiration(serviceData);
  if (isExpired) {
    console.warn(`⏰ Servicio ${serviceData.client_service_id} expirado (${serviceData.status}) — ignorando mensaje`);
    return;
  }

  const clientServiceId = serviceData.client_service_id;

  // Obtener nombre del contacto desde Meta API si no viene en el webhook (Messenger/Instagram)
  let resolvedContactName = contactName;
  if (!resolvedContactName && (platform === 'messenger' || platform === 'instagram')) {
    const creds = serviceData.config?.platform_credentials || {};
    const accessToken = creds.page_access_token || creds.instagram_access_token;
    if (accessToken) {
      resolvedContactName = await fetchUserNameFromMeta(contactId, accessToken);
    }
  }

  // 3. Buscar o crear conversación (INSERT ON CONFLICT evita race condition de duplicados)
  let conversationId;
  let isNewConversation = false;
  let isBotActive = true;

  const upsertConv = await query(`
    INSERT INTO conversations (
      client_service_id, contact_id, contact_name, contact_phone, platform,
      is_bot_active, status, unread_count, last_message_at
    )
    VALUES ($1, $2, $3, $4, $5, true, 'active', 1, CURRENT_TIMESTAMP)
    ON CONFLICT (client_service_id, contact_id)
    DO UPDATE SET
      unread_count = conversations.unread_count + 1,
      last_message_at = CURRENT_TIMESTAMP,
      contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
      contact_phone = COALESCE(EXCLUDED.contact_phone, conversations.contact_phone)
    RETURNING *, (xmax = 0) AS was_inserted
  `, [clientServiceId, contactId, resolvedContactName || 'Sin nombre', contactPhone || '', platform]);

  conversationId = upsertConv.rows[0].id;
  isNewConversation = upsertConv.rows[0].was_inserted;
  isBotActive = upsertConv.rows[0].is_bot_active;

  // 4. Guardar mensaje del contacto (ON CONFLICT evita duplicados si Meta reintenta el webhook)
  const incomingMsg = await query(`
    INSERT INTO messages (
      conversation_id, sender_type, content, message_type, external_id, status
    )
    VALUES ($1, $2, $3, $4, $5, 'delivered')
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING *
  `, [conversationId, SENDER_TYPES.CONTACT, message, messageType || 'text', messageId]);

  // Si el INSERT fue ignorado por duplicado, no procesar más
  if (incomingMsg.rows.length === 0) {
    return;
  }

  // Emitir evento WebSocket de mensaje entrante
  emitNewMessage(serviceData.client_id, serviceData.service_code, {
    conversationId,
    message: incomingMsg.rows[0],
    platform,
    contactName: contactName || contactId
  });

  // Si es nueva conversación, notificar
  if (isNewConversation) {
    emitNewConversation(serviceData.client_id, serviceData.service_code, {
      conversationId,
      contactId,
      contactName: contactName || 'Sin nombre',
      platform
    });
  }

  // 5. Si el bot está activo, generar y enviar respuesta
  if (isBotActive) {
    try {
      // Enviar mensaje de bienvenida si es nueva conversación
      if (isNewConversation) {
        try {
          const botConfigResult = await query(
            'SELECT welcome_message FROM bot_configs WHERE client_service_id = $1',
            [clientServiceId]
          );
          const welcomeMsg = botConfigResult.rows[0]?.welcome_message;
          if (welcomeMsg) {
            await query(`
              INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
              VALUES ($1, $2, $3, 'text', 'pending')
            `, [conversationId, SENDER_TYPES.BOT, welcomeMsg]);

            await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, welcomeMsg, null);
          }
        } catch (welcomeErr) {
          console.error('Error enviando mensaje de bienvenida:', welcomeErr.message);
        }
      }

      // Generar respuesta IA
      await generateAndSendBotResponse({
        conversationId, clientServiceId, serviceData, platform,
        contactId, contactPhone, messageContent: message, messageId,
        mediaId: data.mediaId, wasAudio, birdConversationId
      });


    } catch (aiError) {
      console.error('Error generando respuesta IA:', aiError);

      // Enviar fallback
      const fallbackMsg = 'Lo siento, no puedo responder en este momento. Un agente te atenderá pronto.';
      await query(`
        INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
        VALUES ($1, $2, $3, 'text', 'pending')
      `, [conversationId, SENDER_TYPES.BOT, fallbackMsg]);

      await sendBotMessageToPlatform(platform, serviceData, contactId, contactPhone, fallbackMsg, null);
    }
  } else {
  }
};

// =====================================================
// Procesar status updates (delivered, read, failed)
// =====================================================
const processStatusUpdate = async (data) => {
  const { platform, messageId, status, timestamp, recipientId } = data;

  if (!messageId || !status) return;

  try {
    await query(`
      UPDATE messages SET status = $1
      WHERE external_id = $2
    `, [status, messageId]);
  } catch (error) {
    console.error('Error actualizando status:', error);
  }
};

// =====================================================
// handleIncomingMessage (para llamadas manuales / externas)
// Usa businessId (UUID) para buscar el servicio
// =====================================================
const handleIncomingMessage = async (req, res) => {
  try {
    const {
      platform, businessId, contactId, contactName,
      contactPhone, contactEmail, message,
      messageType = 'text', messageId, timestamp
    } = req.body;

    if (!platform || !businessId || !contactId || !message) {
      return res.status(400).json({
        success: false,
        error: 'Datos incompletos: platform, businessId, contactId y message son requeridos'
      });
    }

    // Buscar client_service por businessId
    const serviceResult = await query(`
      SELECT cs.id as client_service_id, cs.status, cs.config,
             s.code as service_code, s.name as service_name,
             b.id as business_id, b.name as business_name, b.industry, b.description,
             b.website, b.country, b.address, b.phone as business_phone, b.email as business_email,
             c.id as client_id, c.name as client_name
      FROM businesses b
      JOIN clients c ON b.client_id = c.id
      JOIN client_services cs ON c.id = cs.client_id
      JOIN services s ON cs.service_id = s.id
      WHERE b.id = $1 AND s.code = $2
    `, [businessId, platform]);

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Negocio o servicio no encontrado' });
    }

    const serviceData = serviceResult.rows[0];

    if (serviceData.status !== 'active' && serviceData.status !== 'trial') {
      return res.status(403).json({ success: false, error: 'Servicio no activo' });
    }

    const clientServiceId = serviceData.client_service_id;

    // Buscar o crear conversación
    let conversationResult = await query(`
      SELECT * FROM conversations WHERE client_service_id = $1 AND contact_id = $2
    `, [clientServiceId, contactId]);

    let conversationId;
    let isNewConversation = false;
    let isBotActive = true;

    // Upsert conversación (evita race condition de duplicados)
    const upsertConv = await query(`
      INSERT INTO conversations (
        client_service_id, contact_id, contact_name, contact_phone, platform,
        is_bot_active, status, unread_count, last_message_at
      )
      VALUES ($1, $2, $3, $4, $5, true, 'active', 1, CURRENT_TIMESTAMP)
      ON CONFLICT (client_service_id, contact_id)
      DO UPDATE SET
        unread_count = conversations.unread_count + 1,
        last_message_at = CURRENT_TIMESTAMP,
        contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
        contact_phone = COALESCE(EXCLUDED.contact_phone, conversations.contact_phone)
      RETURNING *, (xmax = 0) AS was_inserted
    `, [clientServiceId, contactId, contactName || 'Sin nombre', contactPhone || '', platform]);

    conversationId = upsertConv.rows[0].id;
    isNewConversation = upsertConv.rows[0].was_inserted;
    isBotActive = upsertConv.rows[0].is_bot_active;

    // Guardar mensaje entrante (ON CONFLICT evita duplicados si se reintenta)
    const incomingMsg = await query(`
      INSERT INTO messages (
        conversation_id, sender_type, content, message_type, external_id, status
      )
      VALUES ($1, $2, $3, $4, $5, 'delivered')
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING *
    `, [conversationId, SENDER_TYPES.CONTACT, message, messageType, messageId]);

    // Si el INSERT fue ignorado por duplicado, no procesar más
    if (incomingMsg.rows.length === 0) {
      return res.json({ success: true, data: { conversationId, duplicate: true } });
    }

    // Si el bot está activo, generar respuesta
    if (isBotActive) {
      try {
        const result = await generateAndSendBotResponse({
          conversationId, clientServiceId, serviceData, platform,
          contactId, contactPhone, messageContent: message, messageId
        });

        return res.json({
          success: true,
          data: {
            conversationId,
            incomingMessage: incomingMsg.rows[0],
            botResponse: { content: result.response, shouldSend: true },
            isNewConversation
          }
        });

      } catch (aiError) {
        console.error('Error generando respuesta IA:', aiError);
        const fallbackMsg = 'Lo siento, no puedo responder en este momento. Un agente te atenderá pronto.';

        await query(`
          INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
          VALUES ($1, $2, $3, 'text', 'pending')
        `, [conversationId, SENDER_TYPES.BOT, fallbackMsg]);

        return res.json({
          success: true,
          data: {
            conversationId, incomingMessage: incomingMsg.rows[0],
            botResponse: { content: fallbackMsg, shouldSend: true, isError: true },
            isNewConversation
          }
        });
      }
    }

    res.json({
      success: true,
      data: {
        conversationId, incomingMessage: incomingMsg.rows[0],
        botResponse: null, isBotActive: false, isNewConversation
      }
    });

  } catch (error) {
    console.error('Error en handleIncomingMessage:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// confirmMessageSent
// =====================================================
const confirmMessageSent = async (req, res) => {
  try {
    const { messageId, externalId, status = 'sent' } = req.body;
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'messageId es requerido' });
    }

    await query(`
      UPDATE messages SET status = $1, external_id = $2
      WHERE id = $3
    `, [status, externalId, messageId]);

    res.json({ success: true, message: 'Estado actualizado' });
  } catch (error) {
    console.error('Error en confirmMessageSent:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// updateMessageStatus
// =====================================================
const updateMessageStatus = async (req, res) => {
  try {
    const { externalId, status } = req.body;
    if (!externalId || !status) {
      return res.status(400).json({ success: false, error: 'externalId y status son requeridos' });
    }

    await query(`
      UPDATE messages SET status = $1 WHERE external_id = $2
    `, [status, externalId]);

    res.json({ success: true, message: 'Estado actualizado' });
  } catch (error) {
    console.error('Error en updateMessageStatus:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// verifyWebhook (Meta verification challenge)
// =====================================================
const verifyWebhook = async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Obtener verify token desde env
    const verifyToken = process.env.META_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN;

    if (!verifyToken) {
      console.error('❌ META_VERIFY_TOKEN no configurado en variables de entorno');
      return res.sendStatus(500);
    }

    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(200).send(challenge);
    }

    res.sendStatus(403);
  } catch (error) {
    console.error('Error verificando webhook:', error);
    res.sendStatus(500);
  }
};

// =====================================================
// healthCheck
// =====================================================
const healthCheck = async (req, res) => {
  try {
    await query('SELECT 1');
    const { checkConnection } = require('../services/openaiService');
    const openaiStatus = await checkConnection();

    res.json({
      success: true, status: 'healthy',
      services: { database: true, openai: openaiStatus.success },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, status: 'unhealthy', error: error.message });
  }
};

// =====================================================
// initWebChat
// =====================================================
const initWebChat = async (req, res) => {
  try {
    const { clientServiceId } = req.body;

    if (!clientServiceId) {
      return res.status(400).json({ success: false, error: 'clientServiceId es requerido' });
    }

    // Validar formato UUID para prevenir inyección
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(clientServiceId)) {
      return res.status(400).json({ success: false, error: 'ID de servicio inválido' });
    }

    const serviceResult = await query(`
      SELECT cs.*, s.code, bc.welcome_message
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      LEFT JOIN bot_configs bc ON cs.id = bc.client_service_id
      WHERE cs.id = $1 AND s.code = 'webchat' AND cs.status IN ('active', 'trial')
    `, [clientServiceId]);

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado o inactivo' });
    }

    const service = serviceResult.rows[0];
    const contactId = 'web_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    const conversationResult = await query(`
      INSERT INTO conversations (
        client_service_id, contact_id, contact_name, platform, status, is_bot_active
      ) VALUES ($1, $2, $3, 'webchat', 'active', true) RETURNING *
    `, [clientServiceId, contactId, 'Visitante']);

    const newConversation = conversationResult.rows[0];

    // Emitir evento WebSocket de nueva conversación (para el panel del cliente)
    emitNewConversation(service.client_id, 'webchat', {
      conversationId: newConversation.id,
      contactId,
      contactName: 'Visitante',
      platform: 'webchat'
    });

    // No exponemos conversationId (UUID interno) al widget.
    // sessionId = contactId (ya es aleatorio), más clientServiceId son suficientes para look-up seguro.
    res.json({
      success: true,
      data: {
        sessionId: contactId,
        clientServiceId,
        welcomeMessage: service.welcome_message || '¡Hola! 👋 Bienvenido/a. Soy tu asistente virtual y estoy aquí para ayudarte con todo lo que necesites. ¿Qué estás buscando hoy? 😊'
      }
    });
  } catch (error) {
    console.error('Error en initWebChat:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// sendWebChatMessage
// =====================================================
const sendWebChatMessage = async (req, res) => {
  try {
    // Acepta sessionId+clientServiceId (nuevo, seguro) o conversationId (legacy)
    const { sessionId, clientServiceId: csId, conversationId: legacyConvId, message } = req.body;

    if ((!sessionId && !legacyConvId) || !message) {
      return res.status(400).json({ success: false, error: 'sessionId y message son requeridos' });
    }

    // Limitar longitud del mensaje para prevenir abuso
    if (message.length > 2000) {
      return res.status(400).json({ success: false, error: 'Mensaje demasiado largo (máximo 2000 caracteres)' });
    }

    // Buscar conversación por sessionId+clientServiceId (sin exponer conversationId interno)
    // o por conversationId legado (compatibilidad)
    let convResult;
    if (sessionId && csId) {
      convResult = await query(`
        SELECT c.*, cs.client_id, cs.plan_type, cs.status as service_status,
               cs.trial_ends_at, cs.subscription_ends_at, cs.config as service_config,
               bc.personality, bc.language, bc.ai_config, bc.knowledge_base,
               bc.fallback_message, bc.business_hours, bc.away_message, bc.payment_config,
               b.name as business_name, b.industry, b.description, b.website,
               b.phone as business_phone, b.email as business_email
        FROM conversations c
        JOIN client_services cs ON c.client_service_id = cs.id
        LEFT JOIN bot_configs bc ON cs.id = bc.client_service_id
        LEFT JOIN businesses b ON cs.client_id = b.client_id
        WHERE c.contact_id = $1 AND c.client_service_id = $2
      `, [sessionId, csId]);
    } else {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(legacyConvId)) {
        return res.status(400).json({ success: false, error: 'ID de conversación inválido' });
      }
      convResult = await query(`
        SELECT c.*, cs.client_id, cs.plan_type, cs.status as service_status,
               cs.trial_ends_at, cs.subscription_ends_at, cs.config as service_config,
               bc.personality, bc.language, bc.ai_config, bc.knowledge_base,
               bc.fallback_message, bc.business_hours, bc.away_message, bc.payment_config,
               b.name as business_name, b.industry, b.description, b.website,
               b.phone as business_phone, b.email as business_email
        FROM conversations c
        JOIN client_services cs ON c.client_service_id = cs.id
        LEFT JOIN bot_configs bc ON cs.id = bc.client_service_id
        LEFT JOIN businesses b ON cs.client_id = b.client_id
        WHERE c.id = $1
      `, [legacyConvId]);
    }

    if (convResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }

    const conversation = convResult.rows[0];
    const conversationId = conversation.id; // ID interno, nunca se devuelve al widget

    // Verificar expiración de trial o suscripción (webchat)
    const now = new Date();
    const isTrialExpiredWc = conversation.service_status === 'trial' &&
      conversation.trial_ends_at && new Date(conversation.trial_ends_at) <= now;
    const isSubscriptionExpiredWc = conversation.service_status === 'active' &&
      conversation.subscription_ends_at && new Date(conversation.subscription_ends_at) <= now;

    if (isTrialExpiredWc || isSubscriptionExpiredWc) {
      console.warn(`⏰ Servicio webchat ${conversation.client_service_id} expirado — ignorando mensaje`);
      setImmediate(async () => {
        try {
          const updated = await query(`
            UPDATE client_services SET status = 'expired', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status IN ('trial', 'active') RETURNING id
          `, [conversation.client_service_id]);
          if (updated.rows.length > 0) {
            // Obtener email del cliente para notificar
            const clientRow = await query(
              `SELECT c.id as client_id, c.email, c.name, s.name as service_name FROM clients c
               JOIN client_services cs ON c.id = cs.client_id
               JOIN services s ON cs.service_id = s.id
               WHERE cs.id = $1`, [conversation.client_service_id]
            );
            if (clientRow.rows.length > 0) {
              const { client_id, email, name, service_name } = clientRow.rows[0];
              await sendSubscriptionExpiredEmail(email, name, service_name, 20).catch(() => { });
              try {
                notificationService.createNotification({
                  recipient_type: NotificationRecipientTypes.CLIENT,
                  recipient_id: client_id,
                  type: NotificationTypes.SUBSCRIPTION_EXPIRED,
                  title: '¡Suscripción!',
                  body: `Tu suscripción de ${service_name} ha expirado.`,
                  path: 'client/services',
                  data: clientRow.rows[0]
                });
              } catch (error) {
                console.error(`❌ Error al crear notificación ${NotificationTypes.SUBSCRIPTION_EXPIRED}:`, error);
              }
            }
          }
        } catch (err) {
          console.error('Error marcando webchat como expirado:', err.message);
        }
      });
      return res.status(403).json({ success: false, error: 'Servicio no disponible' });
    }

    // Guardar mensaje del usuario
    const userMsgResult = await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, 'contact', $2, 'text', 'sent') RETURNING *
    `, [conversationId, message]);

    // Emitir evento WebSocket de mensaje entrante (para el panel del cliente)
    emitNewMessage(conversation.client_id, 'webchat', {
      conversationId,
      message: userMsgResult.rows[0],
      platform: 'webchat',
      contactName: 'Visitante'
    });

    if (conversation.is_bot_active) {
      try {
        // 1. Verificar+incrementar límite por conversación de forma ATÓMICA
        const conversationLimitCheck = await atomicCheckAndIncrementConversation(conversationId);
        if (!conversationLimitCheck.allowed) {
          const maintenanceMsg = 'El asistente virtual se encuentra en mantenimiento. Te pondremos en contacto con un agente personal.';
          await query(`
            INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
            VALUES ($1, 'bot', $2, 'text', 'sent')
          `, [conversationId, maintenanceMsg]);

          return res.json({ success: true, data: { userMessage: userMsgResult.rows[0], reply: maintenanceMsg } });
        }

        // 2. Verificar+incrementar límite del servicio de forma ATÓMICA
        const serviceLimitCheck = await atomicCheckAndIncrementService(conversation.client_service_id);
        if (!serviceLimitCheck.allowed) {
          const maintenanceMsg = 'El asistente virtual se encuentra en mantenimiento. Te pondremos en contacto con un agente personal.';
          await query(`
            INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
            VALUES ($1, 'bot', $2, 'text', 'sent')
          `, [conversationId, maintenanceMsg]);

          // Enviar email al cliente
          const clientInfo = await query(
            'SELECT c.id as client_id, c.email, c.name, s.name as service_name FROM clients c JOIN client_services cs ON c.id = cs.client_id JOIN services s ON cs.service_id = s.id WHERE cs.id = $1',
            [conversation.client_service_id]
          );
          if (clientInfo.rows.length > 0) {
            const { client_id, email, name, service_name } = clientInfo.rows[0];
            sendDailyLimitReachedEmail(email, name, service_name, serviceLimitCheck.limit, serviceLimitCheck.status).catch(err => console.error('Error enviando email:', err));
            try {
              notificationService.createNotification({
                recipient_type: NotificationRecipientTypes.CLIENT,
                recipient_id: client_id,
                type: NotificationTypes.SEND_DAILY_LIMIT_REACHED,
                title: '¡Límite de Mensajes Alcanzado!',
                body: `Tu servicio ${service_name} ha alcanzado el límite de mensajes diario.`,
                path: 'client/services',
                data: clientInfo.rows[0]
              });
            } catch (error) {
              console.error(`❌ Error al crear notificación ${NotificationTypes.SEND_DAILY_LIMIT_REACHED}:`, error);
            }
          }

          return res.json({ success: true, data: { userMessage: userMsgResult.rows[0], reply: maintenanceMsg } });
        }

        // Obtener historial
        const historyResult = await query(`
          SELECT sender_type, content FROM messages
          WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10
        `, [conversationId]);

        const messageHistory = historyResult.rows.reverse();

        // Parsear AI config
        let aiConfig = {};
        try {
          aiConfig = typeof conversation.ai_config === 'string'
            ? JSON.parse(conversation.ai_config) : (conversation.ai_config || {});
        } catch { /* defaults */ }

        // Obtener archivos de conocimiento (globales por cliente)
        let knowledgeFiles = [];
        try {
          const kfResult = await query(
            'SELECT filename, extracted_text FROM client_knowledge_files WHERE client_id = $1',
            [conversation.client_id]
          );
          knowledgeFiles = kfResult.rows;
        } catch { /* ignorar si la tabla no existe aún */ }

        const webchatPlanType = conversation.plan_type || 'pro';

        // Para PAYG: verificar saldo antes de llamar a la IA
        if (webchatPlanType === PAYG.PLAN_TYPE) {
          const balanceInfo = await checkBalance(conversation.client_service_id);
          if (balanceInfo.isEmpty) {
            const zeroMsgResult = await query(`
              INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
              VALUES ($1, 'bot', $2, 'text', 'sent') RETURNING *
            `, [conversationId, PAYG.ZERO_BALANCE_RESPONSE]);
            emitBotResponse(conversation.client_id, 'webchat', { conversationId, message: zeroMsgResult.rows[0], platform: 'webchat' });
            return res.json({ success: true, data: { reply: PAYG.ZERO_BALANCE_RESPONSE } });
          }
        }

        // Parse payment_config — desde businesses (global por cliente)
        let wcPaymentConfig = {};
        try {
          const raw = conversation.payment_config;
          wcPaymentConfig = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch { /* usar defaults */ }

        const { content: responseText, usage: wcUsage, productImages: wcProductImages = [] } = await generateResponse({
          userMessage: message,
          messageHistory,
          botConfig: {
            personality: conversation.personality || 'amable y profesional',
            language: conversation.language || 'español',
            instructions: conversation.knowledge_base || '',
            fallbackMessage: conversation.fallback_message,
            model: aiConfig.model || 'gpt-4o-mini',
            temperature: aiConfig.temperature || 0.7,
            maxTokens: aiConfig.max_tokens || 350,
            knowledgeFiles,
            paymentConfig: wcPaymentConfig
          },
          businessInfo: {
            name: conversation.business_name,
            industry: conversation.industry,
            description: conversation.description,
            website: conversation.website,
            phone: conversation.business_phone,
            email: conversation.business_email
          },
          clientId: conversation.client_id,
          conversationId,
          planType: webchatPlanType,
          platform: 'webchat',
        });

        // Detectar handoff: si la IA incluyó [HANDOFF], activar transferencia a humano
        const needsHandoff = responseText.includes('[HANDOFF]');
        const cleanResponse = responseText.replace(/\[HANDOFF\]/g, '').trim();

        const botMsgResult = await query(`
          INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
          VALUES ($1, 'bot', $2, 'text', 'sent') RETURNING *
        `, [conversationId, cleanResponse]);

        await query(`
          UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = $1
        `, [conversationId]);

        // Si se detectó handoff (por [HANDOFF] tag o save_webchat_lead ya lo marcó)
        if (needsHandoff) {
          // save_webchat_lead ya marcó needs_human_attention + is_bot_active=false,
          // pero lo hacemos de nuevo por si solo se usó [HANDOFF] sin el tool
          await query(`
            UPDATE conversations
            SET needs_human_attention = true, is_bot_active = false
            WHERE id = $1
          `, [conversationId]);

          // Obtener nombre actualizado (save_webchat_lead puede haberlo cambiado de "Visitante")
          const updatedConv = await query('SELECT contact_name, contact_phone, contact_email FROM conversations WHERE id = $1', [conversationId]);
          const visitorName = updatedConv.rows[0]?.contact_name || 'Visitante Web';

          emitHumanAttention(conversation.client_id, 'webchat', {
            conversationId,
            contactName: visitorName,
            platform: 'webchat'
          });

          // Notificar al cliente por email con datos del visitante
          setImmediate(async () => {
            try {
              const clientInfo = await query(
                'SELECT c.id as client_id, c.email, c.name FROM clients c WHERE c.id = $1',
                [conversation.client_id]
              );
              if (clientInfo.rows.length > 0) {
                const { client_id, email, name } = clientInfo.rows[0];
                const visitorContact = updatedConv.rows[0]?.contact_phone || updatedConv.rows[0]?.contact_email || 'Sin contacto';
                await sendHumanAttentionEmail(email, name, `${visitorName} (${visitorContact})`, 'webchat', conversationId).catch(() => { });
                try {
                  notificationService.createNotification({
                    recipient_type: NotificationRecipientTypes.CLIENT,
                    recipient_id: client_id,
                    type: NotificationTypes.SEND_HUMAN_ATTENTION,
                    title: '¡Atención Humana Requerida!',
                    body: `Un cliente necesita hablar contigo en ${platform} ahora mismo.`,
                    path: '',
                    data: clientInfo.rows[0]
                  });
                } catch (error) {
                  console.error(`❌ Error al crear notificación ${NotificationTypes.SEND_HUMAN_ATTENTION}:`, error);
                }
              }
            } catch (err) {
              console.error('[Webchat] Error enviando email de atención humana:', err.message);
            }
          });
        }

        // Billing (contador ya fue incrementado atómicamente antes)
        setImmediate(async () => {
          try {
            if (webchatPlanType === PAYG.PLAN_TYPE) {
              const wcPaygPricing = conversation.service_config?.payg_pricing || null;
              await processPaygResponse({
                clientId: conversation.client_id,
                clientServiceId: conversation.client_service_id,
                conversationId,
                messageId: botMsgResult.rows[0].id,
                inputTokens: wcUsage.inputTokens,
                outputTokens: wcUsage.outputTokens,
                provider: wcUsage.provider,
                model: wcUsage.model,
                paygPricing: wcPaygPricing,
              });
            } else if (wcUsage.totalTokens > 0) {
              await recordTokenUsage({
                clientId: conversation.client_id,
                clientServiceId: conversation.client_service_id,
                conversationId,
                messageId: botMsgResult.rows[0].id,
                inputTokens: wcUsage.inputTokens,
                outputTokens: wcUsage.outputTokens,
                provider: wcUsage.provider,
                model: wcUsage.model,
                planType: webchatPlanType,
              });
            }
          } catch (billingErr) {
            console.error('[Billing] Webchat billing error:', billingErr.message);
          }
        });

        // Emitir evento WebSocket de respuesta del bot (para el panel del cliente)
        emitBotResponse(conversation.client_id, 'webchat', {
          conversationId,
          message: botMsgResult.rows[0],
          platform: 'webchat'
        });

        return res.json({
          success: true,
          data: {
            userMessage: userMsgResult.rows[0],
            reply: cleanResponse,
            productImages: wcProductImages.slice(0, 3), // URLs de imágenes de productos para el widget
            handoff: needsHandoff // Indica al widget que se transfirió a un humano
          }
        });

      } catch (aiError) {
        console.error('Error generando respuesta webchat:', aiError);
        const fallback = conversation.fallback_message || 'Disculpa, estoy teniendo problemas. Un agente te atenderá pronto.';
        const fallbackMsgResult = await query(`
          INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
          VALUES ($1, 'bot', $2, 'text', 'sent') RETURNING *
        `, [conversationId, fallback]);

        // Emitir evento WebSocket del mensaje de fallback
        emitBotResponse(conversation.client_id, 'webchat', {
          conversationId,
          message: fallbackMsgResult.rows[0],
          platform: 'webchat'
        });

        return res.json({ success: true, data: { userMessage: userMsgResult.rows[0], reply: fallback } });
      }
    }

    res.json({
      success: true,
      data: { userMessage: userMsgResult.rows[0], reply: null, message: 'Un agente te responderá pronto.' }
    });

  } catch (error) {
    console.error('Error en sendWebChatMessage:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// HELPER: Procesar update de Telegram (single-bot architecture)
// El bot global del admin recibe todos los mensajes.
// Deep linking: t.me/Bot?start=CLIENT_SERVICE_ID asocia el chat con un cliente.
// =====================================================
async function processTelegramUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  // Aceptar texto, foto, voz y audio — ignorar el resto
  const hasText = !!msg.text;
  const hasPhoto = !!msg.photo;
  const hasVoice = !!msg.voice;   // Nota de voz
  const hasAudio = !!msg.audio;   // Archivo de audio
  if (!hasText && !hasPhoto && !hasVoice && !hasAudio) return;

  const chatId = msg.chat.id.toString();
  const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
  const botToken = telegramService.getGlobalBotToken();

  if (!botToken) {
    return;
  }

  // ---- Deep linking: /start CLIENT_SERVICE_ID ----
  let deepLinkCsId = null;
  if (msg.text.startsWith('/start ')) {
    deepLinkCsId = msg.text.replace('/start ', '').trim();
  }

  let serviceData = null;

  // 1. Si viene un deep link /start con client_service_id
  if (deepLinkCsId) {
    const result = await query(`
      SELECT cs.id as client_service_id, cs.status, cs.config,
             s.code as service_code, s.name as service_name,
             b.id as business_id, b.name as business_name, b.industry, b.description,
             b.website, b.country, b.address, b.phone as business_phone, b.email as business_email,
             c.id as client_id, c.name as client_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      JOIN clients c ON cs.client_id = c.id
      JOIN businesses b ON c.id = b.client_id
      WHERE cs.id = $1 AND s.code = 'telegram' AND cs.status IN ('active', 'trial')
    `, [deepLinkCsId]);

    serviceData = result.rows[0] || null;
  }

  // 2. Buscar por conversacion existente (este chatId ya hablo antes)
  if (!serviceData) {
    const existingConv = await query(`
      SELECT c.client_service_id
      FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE c.contact_id = $1 AND s.code = 'telegram' AND cs.status IN ('active', 'trial')
      ORDER BY c.last_message_at DESC
      LIMIT 1
    `, [chatId]);

    if (existingConv.rows.length > 0) {
      const csId = existingConv.rows[0].client_service_id;
      const result = await query(`
        SELECT cs.id as client_service_id, cs.status, cs.config,
               s.code as service_code, s.name as service_name,
               b.id as business_id, b.name as business_name, b.industry, b.description,
               b.website, b.country, b.address, b.phone as business_phone, b.email as business_email,
               c.id as client_id, c.name as client_name
        FROM client_services cs
        JOIN services s ON cs.service_id = s.id
        JOIN clients c ON cs.client_id = c.id
        JOIN businesses b ON c.id = b.client_id
        WHERE cs.id = $1
      `, [csId]);

      serviceData = result.rows[0] || null;
    }
  }

  // 3. Si no encontramos nada, no podemos rutear el mensaje
  if (!serviceData) {
    // Si es /start sin payload valido, enviar mensaje generico
    if (msg.text === '/start') {
      await telegramService.sendTelegramText(botToken, chatId,
        'Bienvenido. Para conectarte con un negocio, usa el link que te compartieron.',
        {}
      );
    }
    return;
  }

  const csId = serviceData.client_service_id;

  // Buscar o crear conversacion
  let convResult = await query(`
    SELECT * FROM conversations WHERE client_service_id = $1 AND contact_id = $2
  `, [csId, chatId]);

  let conversationId;
  let isNewConversation = false;

  if (convResult.rows.length === 0) {
    const newConv = await query(`
      INSERT INTO conversations (
        client_service_id, contact_id, contact_name, platform,
        is_bot_active, status, last_message_at
      )
      VALUES ($1, $2, $3, 'telegram', true, 'active', CURRENT_TIMESTAMP)
      RETURNING *
    `, [csId, chatId, userName]);

    conversationId = newConv.rows[0].id;
    isNewConversation = true;
  } else {
    conversationId = convResult.rows[0].id;
    await query(`
      UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, unread_count = unread_count + 1
      WHERE id = $1
    `, [conversationId]);
  }

  // Si es /start con deep link, no guardar el comando como mensaje, solo saludar
  if (deepLinkCsId && msg.text.startsWith('/start ')) {
    // Emitir nueva conversacion por WebSocket
    if (isNewConversation) {
      emitNewConversation(serviceData.client_id, 'telegram', {
        conversationId, contactId: chatId, contactName: userName, platform: 'telegram'
      });
    }

    // Generar respuesta de bienvenida del bot
    const botConfig = await query('SELECT * FROM bot_configs WHERE client_service_id = $1', [csId]);
    const welcomeMsg = botConfig.rows[0]?.welcome_message || `¡Hola ${userName}! 👋 Bienvenido/a. Soy tu asistente virtual y estoy aquí para ayudarte. ¿En qué puedo servirte hoy? 😊`;

    // Guardar y enviar saludo
    await query(`
      INSERT INTO messages (conversation_id, sender_type, content, message_type, status)
      VALUES ($1, 'bot', $2, 'text', 'sent')
    `, [conversationId, welcomeMsg]);

    await telegramService.sendTelegramText(botToken, chatId, welcomeMsg, {});
    return;
  }

  // Deduplicación: evitar procesar mensajes duplicados (retries de Telegram)
  const telegramMsgId = msg.message_id.toString();
  try {
    const existingMsg = await query(
      'SELECT id FROM messages WHERE external_id = $1 AND conversation_id = $2',
      [telegramMsgId, conversationId]
    );
    if (existingMsg.rows.length > 0) {
      return; // Mensaje duplicado, ignorar
    }
  } catch (dedupErr) {
    console.warn('Error en dedup check Telegram:', dedupErr.message);
  }

  // Determinar contenido del mensaje (texto, foto, o voz/audio → transcribir)
  let msgText = msg.text || msg.caption || (msg.photo ? '[Foto enviada - posible comprobante de pago]' : null);

  // Transcribir voz/audio con OpenAI Whisper
  let telegramWasAudio = false;
  if (!msgText && (msg.voice || msg.audio)) {
    telegramWasAudio = true;
    try {
      const fileId = msg.voice?.file_id || msg.audio?.file_id;
      const botToken = telegramService.getGlobalBotToken();
      if (fileId && botToken) {
        const { buffer, mimeType } = await downloadTelegramAudio(fileId, botToken);
        const transcription = await transcribeAudio(buffer, mimeType);
        if (transcription) {
          msgText = `🎤 ${transcription}`;
          console.log(`[Audio→Texto] Telegram: "${transcription.substring(0, 80)}"`);
        }
      }
    } catch (audioErr) {
      console.error('[Audio] Error transcribiendo Telegram:', audioErr.message);
      msgText = '🎤 [Audio no transcribible]';
    }
  }

  if (!msgText) return; // Ignorar mensajes vacíos sin texto

  // Guardar mensaje del usuario
  const incomingMsg = await query(`
    INSERT INTO messages (conversation_id, sender_type, content, message_type, external_id, status)
    VALUES ($1, 'contact', $2, $3, $4, 'received')
    RETURNING *
  `, [conversationId, msgText, msg.photo ? 'image' : 'text', telegramMsgId]);

  // Emitir WebSocket
  emitNewMessage(serviceData.client_id, 'telegram', {
    conversationId,
    message: incomingMsg.rows[0],
    platform: 'telegram',
    contactName: userName
  });

  if (isNewConversation) {
    emitNewConversation(serviceData.client_id, 'telegram', {
      conversationId, contactId: chatId, contactName: userName, platform: 'telegram'
    });
  }

  // Verificar si bot esta activo (explícito: solo true si es exactamente true)
  const isBotActive = convResult.rows[0]?.is_bot_active === true || isNewConversation;

  if (isBotActive) {
    try {
      // generateAndSendBotResponse ahora maneja el envío de Telegram directamente
      // (incluye [SPLIT], delays, typing indicator)
      await generateAndSendBotResponse({
        conversationId, clientServiceId: csId, serviceData, platform: 'telegram',
        contactId: chatId, contactPhone: null, messageContent: msgText,
        messageId: msg.message_id.toString(), wasAudio: telegramWasAudio
      });
    } catch (aiError) {
      console.error('Error generando respuesta Telegram:', aiError);
    }
  }
}

// =====================================================
// handleTelegramWebhook (ruta unica /webhook/telegram)
// =====================================================
const handleTelegramWebhook = async (req, res) => {
  try {
    res.json({ success: true });
    await processTelegramUpdate(req.body);
  } catch (error) {
    console.error('Error en handleTelegramWebhook:', error);
    if (!res.headersSent) res.json({ success: true });
  }
};

// =====================================================
// handleTelegramWebhookByClient (legacy, redirige a la ruta principal)
// =====================================================
const handleTelegramWebhookByClient = async (req, res) => {
  try {
    res.json({ success: true });
    await processTelegramUpdate(req.body);
  } catch (error) {
    console.error('Error en handleTelegramWebhookByClient:', error);
    if (!res.headersSent) res.json({ success: true });
  }
};

// =====================================================
// PAYPAL WEBHOOK
// =====================================================
const handlePayPalWebhook = async (req, res) => {
  try {
    // Responder rápido a PayPal
    res.sendStatus(200);

    const event = req.body;
    const eventType = event.event_type;
    const resource = event.resource;


    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = resource.id;
      const amount = resource.amount?.value;
      const currency = resource.amount?.currency_code;
      const customId = resource.custom_id; // Metadata

      // Verificar Metadata
      if (!customId) {
        console.error('⚠️ Webhook PayPal sin custom_id (metadata)');
        return;
      }

      let metadata = {};
      try {
        metadata = JSON.parse(customId);
      } catch (e) {
        console.error('⚠️ Error parseando metadata de PayPal:', e);
        return;
      }

      const { clientServiceId, planType, paypalOrderId } = metadata;

      // Buscar pago por paypal_order_id (preciso) o fallback a último pendiente
      let paymentResult;
      if (paypalOrderId) {
        paymentResult = await query(`
          SELECT * FROM payments
          WHERE client_service_id = $1 AND paypal_order_id = $2 AND status = 'pending' AND method = 'paypal'
          LIMIT 1
        `, [clientServiceId, paypalOrderId]);
      }

      // Fallback si no se encontró por order_id
      if (!paymentResult || paymentResult.rows.length === 0) {
        paymentResult = await query(`
          SELECT * FROM payments
          WHERE client_service_id = $1 AND status = 'pending' AND method = 'paypal'
          ORDER BY created_at DESC LIMIT 1
        `, [clientServiceId]);
      }

      if (paymentResult.rows.length === 0) {
        console.error('⚠️ No se encontró pago pendiente para servicio:', clientServiceId);
        return;
      }

      const payment = paymentResult.rows[0];

      // Idempotencia: verificar si ya se procesó este capture
      if (payment.paypal_capture_id === captureId) {
        console.warn('⚠️ Webhook PayPal duplicado - captureId ya procesado:', captureId);
        return;
      }

      // Validar que el monto coincida
      if (amount && parseFloat(amount) !== parseFloat(payment.amount)) {
        console.error(`⚠️ MONTO NO COINCIDE: PayPal=${amount}, DB=${payment.amount} para pago ${payment.id}`);
        return;
      }

      // Usar transacción atómica para pago + activación de servicio
      try {
        await query('BEGIN');

        await query(`
          UPDATE payments
          SET status = 'completed', paypal_capture_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `, [captureId, payment.id]);

        await query(`
          UPDATE client_services
          SET status = 'active',
              subscription_started_at = COALESCE(subscription_started_at, CURRENT_TIMESTAMP),
              subscription_ends_at = CURRENT_TIMESTAMP + INTERVAL '30 days',
              plan_type = COALESCE($2, plan_type),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [clientServiceId, planType]);

        await query('COMMIT');
      } catch (txError) {
        await query('ROLLBACK');
        console.error('Error en transacción de pago PayPal:', txError);
        return;
      }
    }

  } catch (error) {
    console.error('Error procesando webhook PayPal:', error);
  }
};

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  processWebhookMessage,
  processStatusUpdate,
  handleIncomingMessage,
  confirmMessageSent,
  updateMessageStatus,
  verifyWebhook,
  healthCheck,
  initWebChat,
  sendWebChatMessage,
  handleTelegramWebhook,
  handleTelegramWebhookByClient,
  handlePayPalWebhook
};
