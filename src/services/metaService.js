const axios = require('axios');
const { query } = require('../config/database');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// =====================================================
// CONFIGURACIÓN
// =====================================================

/**
 * Obtener configuración GLOBAL de Meta API (para admin)
 * NOTA: Para operaciones de clientes, usar las credenciales de client_services.config
 */
async function getMetaConfig() {
  const result = await query(`
    SELECT value FROM system_config WHERE key = 'meta_api_config'
  `);

  if (result.rows.length === 0) {
    throw new Error('Meta API no está configurada');
  }

  return JSON.parse(result.rows[0].value);
}

/**
 * Obtener credenciales de un cliente específico
 */
async function getClientCredentials(clientServiceId) {
  const result = await query(`
    SELECT config FROM client_services WHERE id = $1
  `, [clientServiceId]);

  if (result.rows.length === 0) {
    throw new Error('Servicio de cliente no encontrado');
  }

  const config = result.rows[0].config || {};
  return config.platform_credentials || config.api_credentials || {};
}

/**
 * Resolver token de acceso: usa el del cliente si existe, sino el global
 */
async function resolveAccessToken(clientToken) {
  if (clientToken) return clientToken;

  try {
    const globalConfig = await getMetaConfig();
    return globalConfig.whatsapp_access_token;
  } catch {
    throw new Error('No se encontró token de acceso');
  }
}

async function isConfigured() {
  try {
    const config = await getMetaConfig();
    return !!(config.meta_app_id && config.whatsapp_access_token);
  } catch {
    return false;
  }
}

// =====================================================
// WHATSAPP
// =====================================================

/**
 * Enviar texto por WhatsApp CON token específico del cliente
 */
async function sendWhatsAppTextWithToken(phoneNumberId, recipientPhone, message, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'text',
      text: { preview_url: false, body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      messageId: response.data.messages?.[0]?.id,
      data: response.data
    };
  } catch (error) {
    console.error('Error enviando mensaje WhatsApp:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
}

/**
 * Enviar texto por WhatsApp (usa token global - backward compatible)
 */
async function sendWhatsAppText(phoneNumberId, recipientPhone, message) {
  return sendWhatsAppTextWithToken(phoneNumberId, recipientPhone, message, null);
}

/**
 * Enviar imagen por WhatsApp
 */
async function sendWhatsAppImage(phoneNumberId, recipientPhone, imageUrl, caption = '', accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'image',
      image: { link: imageUrl, caption }
    }, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });

    return { success: true, messageId: response.data.messages?.[0]?.id, data: response.data };
  } catch (error) {
    console.error('Error enviando imagen WhatsApp:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Marcar mensaje como leído CON token del cliente
 */
async function markWhatsAppAsReadWithToken(phoneNumberId, messageId, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${phoneNumberId}/messages`;

  try {
    await axios.post(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    }, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    return { success: true };
  } catch (error) {
    console.error('Error marcando como leído:', error.response?.data || error.message);
    return { success: false };
  }
}

async function markWhatsAppAsRead(phoneNumberId, messageId) {
  return markWhatsAppAsReadWithToken(phoneNumberId, messageId, null);
}

// =====================================================
// MESSENGER
// =====================================================

async function sendMessengerText(pageAccessToken, recipientId, message) {
  const url = `${GRAPH_API_URL}/me/messages`;

  try {
    const response = await axios.post(url, {
      recipient: { id: recipientId },
      message: { text: message }
    }, {
      headers: { 'Authorization': `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' }
    });

    return { success: true, messageId: response.data.message_id, data: response.data };
  } catch (error) {
    console.error('Error enviando mensaje Messenger:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function sendMessengerImage(pageAccessToken, recipientId, imageUrl) {
  const url = `${GRAPH_API_URL}/me/messages`;

  try {
    const response = await axios.post(url, {
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } }
    }, {
      headers: { 'Authorization': `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' }
    });

    return { success: true, messageId: response.data.message_id, data: response.data };
  } catch (error) {
    console.error('Error enviando imagen Messenger:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function sendMessengerTypingIndicator(pageAccessToken, recipientId, action = 'typing_on') {
  const url = `${GRAPH_API_URL}/me/messages`;

  try {
    await axios.post(url, {
      recipient: { id: recipientId },
      sender_action: action
    }, {
      headers: { 'Authorization': `Bearer ${pageAccessToken}`, 'Content-Type': 'application/json' }
    });
    return { success: true };
  } catch (error) {
    return { success: false };
  }
}

// =====================================================
// INSTAGRAM
// =====================================================

async function sendInstagramText(pageAccessToken, recipientId, message) {
  return sendMessengerText(pageAccessToken, recipientId, message);
}

async function sendInstagramImage(pageAccessToken, recipientId, imageUrl) {
  return sendMessengerImage(pageAccessToken, recipientId, imageUrl);
}

// =====================================================
// MEDIA DOWNLOAD
// =====================================================

/**
 * Download media URL from WhatsApp Graph API using a media ID.
 * Returns the direct download URL that can be fetched with the access token.
 */
async function downloadWhatsAppMedia(mediaId, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${mediaId}`;

  try {
    // Step 1: Get media URL from media ID
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const mediaUrl = response.data?.url;
    if (!mediaUrl) throw new Error('No media URL returned');

    // Step 2: Download the actual media as base64
    const mediaResponse = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    const mimeType = mediaResponse.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(mediaResponse.data).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      success: true,
      url: mediaUrl,
      dataUrl,
      mimeType,
      size: mediaResponse.data.length
    };
  } catch (error) {
    console.error('Error downloading WhatsApp media:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// =====================================================
// HELPERS
// =====================================================

async function getWhatsAppPhoneInfo(phoneNumberId, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${phoneNumberId}`;

  try {
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    return response.data;
  } catch (error) {
    console.error('Error obteniendo info del número:', error.response?.data || error.message);
    throw new Error('Error al obtener información del número');
  }
}

async function getWhatsAppBusinessAccount(businessAccountId, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const url = `${GRAPH_API_URL}/${businessAccountId}`;

  try {
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      params: { fields: 'id,name,timezone_id,message_template_namespace' }
    });
    return response.data;
  } catch (error) {
    console.error('Error obteniendo Business Account:', error.response?.data || error.message);
    throw new Error('Error al obtener WhatsApp Business Account');
  }
}

/**
 * Subir audio a WhatsApp Media API y enviarlo como mensaje de audio
 */
async function sendWhatsAppAudio(phoneNumberId, recipientPhone, audioBuffer, accessToken) {
  const token = await resolveAccessToken(accessToken);
  const FormData = require('form-data');

  // 1. Subir el audio a la Media API
  const uploadUrl = `${GRAPH_API_URL}/${phoneNumberId}/media`;
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/mpeg');

  let mediaId;
  try {
    const uploadRes = await axios.post(uploadUrl, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` }
    });
    mediaId = uploadRes.data?.id;
  } catch (err) {
    console.error('[WhatsApp Audio] Error subiendo media:', err.response?.data || err.message);
    return { success: false, error: 'Error subiendo audio' };
  }

  if (!mediaId) return { success: false, error: 'No se obtuvo media ID' };

  // 2. Enviar el mensaje de audio
  const msgUrl = `${GRAPH_API_URL}/${phoneNumberId}/messages`;
  try {
    const res = await axios.post(msgUrl, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'audio',
      audio: { id: mediaId }
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    return { success: true, messageId: res.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp Audio] Error enviando audio:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

/**
 * Enviar mensaje según plataforma (función genérica)
 */
async function sendMessage(platform, credentials, recipientId, message) {
  switch (platform) {
    case 'whatsapp':
      return await sendWhatsAppTextWithToken(
        credentials.phoneNumberId, recipientId, message, credentials.accessToken
      );
    case 'messenger':
      return await sendMessengerText(credentials.pageAccessToken, recipientId, message);
    case 'instagram':
      return await sendInstagramText(credentials.pageAccessToken, recipientId, message);
    default:
      throw new Error(`Plataforma no soportada: ${platform}`);
  }
}

module.exports = {
  // Configuración
  getMetaConfig,
  getClientCredentials,
  isConfigured,

  // WhatsApp
  sendWhatsAppText,
  sendWhatsAppTextWithToken,
  sendWhatsAppImage,
  sendWhatsAppAudio,
  markWhatsAppAsRead,
  markWhatsAppAsReadWithToken,
  getWhatsAppPhoneInfo,
  getWhatsAppBusinessAccount,
  downloadWhatsAppMedia,

  // Messenger
  sendMessengerText,
  sendMessengerImage,
  sendMessengerTypingIndicator,

  // Instagram
  sendInstagramText,
  sendInstagramImage,

  // General
  sendMessage
};
