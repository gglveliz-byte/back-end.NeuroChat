/**
 * birdService.js
 * Bird (formerly MessageBird) API integration for WhatsApp, Instagram, and Messenger.
 * Docs: https://developers.messagebird.com/api/conversations/
 */

const axios = require('axios');

const BIRD_API_URL = 'https://api.bird.com';

/**
 * Get a pre-configured axios instance for Bird API calls.
 */
function getBirdClient() {
    const apiKey = process.env.BIRD_API_KEY;
    if (!apiKey) throw new Error('BIRD_API_KEY no está configurada en variables de entorno');
    return axios.create({
        baseURL: BIRD_API_URL,
        headers: {
            'Authorization': `AccessKey ${apiKey}`,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });
}

/**
 * Send a text message via Bird Conversations API.
 * @param {string} conversationId - Bird conversation ID
 * @param {string} text - Text to send
 * @returns {Promise<{ success: boolean, messageId?: string }>}
 */
async function sendBirdText(conversationId, text) {
    try {
        const client = getBirdClient();
        const workspaceId = process.env.BIRD_WORKSPACE_ID;
        const resp = await client.post(
            `/workspaces/${workspaceId}/conversations/${conversationId}/messages`,
            {
                body: {
                    type: 'text',
                    text: { text },
                },
            }
        );
        return { success: true, messageId: resp.data?.id };
    } catch (err) {
        const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error('[Bird] Error enviando texto:', msg);
        return { success: false, error: msg };
    }
}

/**
 * Send an image message via Bird Conversations API.
 * @param {string} conversationId - Bird conversation ID
 * @param {string} imageUrl - Public URL of the image
 * @param {string} caption - Optional caption text
 */
async function sendBirdImage(conversationId, imageUrl, caption = '') {
    try {
        const client = getBirdClient();
        const workspaceId = process.env.BIRD_WORKSPACE_ID;
        await client.post(
            `/workspaces/${workspaceId}/conversations/${conversationId}/messages`,
            {
                body: {
                    type: 'image',
                    image: {
                        url: imageUrl,
                        caption,
                    },
                },
            }
        );
        return { success: true };
    } catch (err) {
        console.error('[Bird] Error enviando imagen:', err.message);
        return { success: false };
    }
}

/**
 * Send an audio (voice note) message via Bird.
 * @param {string} conversationId - Bird conversation ID
 * @param {string} audioUrl - Public URL of the audio file
 */
async function sendBirdAudio(conversationId, audioUrl) {
    try {
        const client = getBirdClient();
        const workspaceId = process.env.BIRD_WORKSPACE_ID;
        await client.post(
            `/workspaces/${workspaceId}/conversations/${conversationId}/messages`,
            {
                body: {
                    type: 'audio',
                    audio: { url: audioUrl },
                },
            }
        );
        return { success: true };
    } catch (err) {
        console.error('[Bird] Error enviando audio:', err.message);
        return { success: false };
    }
}

/**
 * Mark a Bird conversation message as read.
 */
async function markBirdAsRead(conversationId) {
    try {
        const client = getBirdClient();
        const workspaceId = process.env.BIRD_WORKSPACE_ID;
        await client.patch(
            `/workspaces/${workspaceId}/conversations/${conversationId}`,
            { status: 'active' }
        );
    } catch (_) { /* silencioso */ }
}

/**
 * Map our internal platform name to Bird's channel template string.
 */
function platformToTemplate(platform) {
    switch (platform) {
        case 'whatsapp':  return 'whatsapp:1';
        case 'instagram': return 'instagram:1';
        case 'messenger': return 'facebook-messenger:1';
        default:          return null;
    }
}

/**
 * Register a client's channel (WhatsApp/Instagram/Messenger) in Bird's workspace.
 * Called after a successful Meta OAuth so Bird can route messages for this channel.
 *
 * @param {string} platform - 'whatsapp' | 'instagram' | 'messenger'
 * @param {object} credentials - platform_credentials from oauthController (page_access_token, waba_id, etc.)
 * @returns {Promise<{ success: boolean, channelId?: string }>}
 */
async function createChannelConnector(platform, credentials) {
    try {
        const client = getBirdClient();
        const workspaceId = process.env.BIRD_WORKSPACE_ID;
        if (!workspaceId) throw new Error('BIRD_WORKSPACE_ID no está configurada');

        const template = platformToTemplate(platform);
        if (!template) throw new Error(`Plataforma no soportada por Bird: ${platform}`);

        // Build the connector payload according to Bird's Connector API
        // https://docs.bird.com/api/channels-api/api-reference/channel-connectors
        const connectorPayload = {
            template,
            ...(platform === 'whatsapp' && {
                config: {
                    wabaId: credentials.waba_id,
                    phoneNumberId: credentials.phone_number_id,
                    accessToken: credentials.whatsapp_access_token,
                },
            }),
            ...((platform === 'instagram' || platform === 'messenger') && {
                config: {
                    pageId: credentials.page_id,
                    accessToken: credentials.page_access_token,
                    ...(platform === 'instagram' && { instagramAccountId: credentials.instagram_account_id }),
                },
            }),
        };

        const resp = await client.post(
            `/workspaces/${workspaceId}/connectors`,
            connectorPayload
        );

        const channelId = resp.data?.id || resp.data?.channelId;
        console.log(`[Bird] Canal registrado para ${platform}: ${channelId}`);
        return { success: true, channelId };
    } catch (err) {
        const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error(`[Bird] Error creando conector para ${platform}:`, msg);
        return { success: false, error: msg };
    }
}

module.exports = {
    sendBirdText,
    sendBirdImage,
    sendBirdAudio,
    markBirdAsRead,
    createChannelConnector,
};
