const axios = require('axios');
const { query } = require('../config/database');

/**
 * Servicio para interactuar con Telegram Bot API
 */

// Obtener configuración de Telegram desde system_config
async function getTelegramConfig() {
  const result = await query(`
    SELECT value FROM system_config WHERE key = 'telegram_config'
  `);

  if (result.rows.length === 0) {
    throw new Error('Telegram no está configurado en el sistema');
  }

  return JSON.parse(result.rows[0].value);
}

/**
 * Enviar mensaje de texto via Telegram
 */
async function sendTelegramText(botToken, chatId, text, options = {}) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const data = {
      chat_id: chatId,
      text: text,
      parse_mode: options.parse_mode || 'HTML',
      disable_web_page_preview: options.disable_preview !== false
    };

    if (options.reply_to_message_id) {
      data.reply_to_message_id = options.reply_to_message_id;
    }

    const response = await axios.post(url, data);

    return {
      success: true,
      messageId: response.data.result.message_id
    };
  } catch (error) {
    console.error('Error enviando mensaje de Telegram:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Enviar foto via Telegram
 */
async function sendTelegramPhoto(botToken, chatId, photoUrl, caption) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;

    const data = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption || ''
    };

    const response = await axios.post(url, data);

    return {
      success: true,
      messageId: response.data.result.message_id
    };
  } catch (error) {
    console.error('Error enviando foto de Telegram:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Enviar documento via Telegram
 */
async function sendTelegramDocument(botToken, chatId, documentUrl, caption) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendDocument`;

    const data = {
      chat_id: chatId,
      document: documentUrl,
      caption: caption || ''
    };

    const response = await axios.post(url, data);

    return {
      success: true,
      messageId: response.data.result.message_id
    };
  } catch (error) {
    console.error('Error enviando documento de Telegram:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Marcar mensaje como leído (Telegram no tiene read receipts como WhatsApp)
 */
async function markTelegramAsRead(botToken, chatId) {
  // Telegram no tiene API para marcar como leído
  // Pero podemos enviar una acción de "typing" para indicar actividad
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
    await axios.post(url, {
      chat_id: chatId,
      action: 'typing'
    });
    return { success: true };
  } catch (error) {
    console.error('Error enviando chat action:', error.response?.data || error.message);
    return { success: false };
  }
}

/**
 * Configurar webhook para Telegram
 */
async function setTelegramWebhook(botToken, webhookUrl) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/setWebhook`;

    const response = await axios.post(url, {
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      url: webhookUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query']
    });

    return {
      success: response.data.ok,
      description: response.data.description
    };
  } catch (error) {
    console.error('Error configurando webhook de Telegram:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Obtener información del bot
 */
async function getBotInfo(botToken) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getMe`;
    const response = await axios.get(url);

    return {
      success: true,
      bot: response.data.result
    };
  } catch (error) {
    console.error('Error obteniendo info del bot:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Eliminar webhook
 */
async function deleteTelegramWebhook(botToken) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
    const response = await axios.post(url);

    return {
      success: response.data.ok
    };
  } catch (error) {
    console.error('Error eliminando webhook:', error.response?.data || error.message);
    throw error;
  }
}

// ==================== BOT GLOBAL (token del .env) ====================

// Cache del bot info global
let globalBotInfo = null;

/**
 * Obtener el bot token global del .env
 */
function getGlobalBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

/**
 * Obtener info del bot global (cacheada)
 */
async function getGlobalBotInfo() {
  if (globalBotInfo) return globalBotInfo;

  const token = getGlobalBotToken();
  if (!token) return null;

  try {
    const info = await getBotInfo(token);
    if (info.success) {
      globalBotInfo = info.bot;
      return globalBotInfo;
    }
  } catch (err) {
    console.error('Error obteniendo info del bot global:', err.message);
  }
  return null;
}

/**
 * Setup inicial del bot: validar token y configurar webhook
 */
async function setupGlobalBot() {
  const token = getGlobalBotToken();
  if (!token) {
    console.log('⚠️  TELEGRAM_BOT_TOKEN no configurado');
    return { success: false, error: 'Token no configurado' };
  }

  try {
    // Validar token
    const info = await getBotInfo(token);
    if (!info.success) {
      console.log('❌ TELEGRAM_BOT_TOKEN invalido');
      return { success: false, error: 'Token invalido' };
    }

    globalBotInfo = info.bot;
    console.log(`✅ Telegram bot conectado: @${info.bot.username}`);

    // Configurar webhook
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const webhookUrl = `${backendUrl}/api/v1/webhook/telegram`;

    try {
      await setTelegramWebhook(token, webhookUrl);
      console.log(`✅ Telegram webhook configurado: ${webhookUrl}`);
    } catch (err) {
      console.log(`⚠️  No se pudo configurar webhook (necesita HTTPS en produccion): ${err.message}`);
    }

    return { success: true, bot: info.bot };
  } catch (err) {
    console.error('❌ Error en setup de Telegram:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getTelegramConfig,
  sendTelegramText,
  sendTelegramPhoto,
  sendTelegramDocument,
  markTelegramAsRead,
  setTelegramWebhook,
  getBotInfo,
  deleteTelegramWebhook,
  getGlobalBotToken,
  getGlobalBotInfo,
  setupGlobalBot
};
