/**
 * birdController.js
 * Handles Bird (formerly MessageBird) webhooks for WhatsApp, Instagram, and Messenger.
 * Bird sends a unified webhook payload regardless of the channel (WA / IG / Messenger).
 * 
 * Flow:
 *   Bird Webhook → birdController → processWebhookMessage (existing AI pipeline)
 *
 * Environment variables needed (.env):
 *   BIRD_API_KEY        — API Key from Bird Developer panel
 *   BIRD_WORKSPACE_ID   — Workspace UUID from Bird (in the URL: app.bird.com/workspaces/{UUID})
 *   BIRD_SIGNING_KEY    — (Optional) Signing key for validating Bird webhook signatures
 */

const { processWebhookMessage } = require('./webhookController');
const { transcribeAudio, downloadAudioFromUrl } = require('../services/audioService');
const birdService = require('../services/birdService');

// ─── Helper: Map Bird channel type to our internal platform code ───────────────
function mapBirdChannelToPlatform(channelType = '') {
    const ch = channelType.toLowerCase();
    if (ch.includes('whatsapp')) return 'whatsapp';
    if (ch.includes('instagram')) return 'instagram';
    if (ch.includes('messenger') || ch.includes('facebook')) return 'messenger';
    return 'whatsapp'; // fallback
}

// ─── Helper: Extract message content and type from Bird message body ───────────
function extractBirdMessageContent(body = {}) {
    switch (body.type) {
        case 'text': return { content: body.text?.text || '', type: 'text' };
        case 'image': return { content: body.image?.caption || '[Imagen recibida]', type: 'image', mediaUrl: body.image?.url };
        case 'audio': return { content: '🎤 [Audio de voz]', type: 'audio', audioUrl: body.audio?.url };
        case 'video': return { content: body.video?.caption || '[Video recibido]', type: 'video' };
        case 'document': return { content: body.document?.filename || '[Documento]', type: 'document' };
        case 'location': return { content: `[Ubicación: ${body.location?.latitude}, ${body.location?.longitude}]`, type: 'location' };
        case 'sticker': return { content: '[Sticker]', type: 'sticker' };
        default: return { content: `[${body.type || 'Mensaje'}]`, type: body.type || 'text' };
    }
}

// ─── MAIN: Handle incoming Bird webhook ───────────────────────────────────────
const handleBirdWebhook = async (req, res) => {
    // 1. Respond to Bird immediately (Bird expects a fast 200 OK)
    res.sendStatus(200);

    try {
        const payload = req.body;

        // Bird sends an array of events
        const events = Array.isArray(payload) ? payload : [payload];

        for (const event of events) {
            try {
                // We only care about incoming messages (type: "message.created", direction: "incoming")
                if (event.type !== 'message.created') continue;

                const message = event.payload; // The message object
                if (!message) continue;

                const direction = message.direction || message.flow;
                if (direction !== 'inbound' && direction !== 'received') continue;

                // Extract conversation and contact info
                const birdConversationId = message.conversationId || message.conversation?.id;
                const contact = message.to?.[0] || message.sender || {};
                const sender = message.from || message.sender || {};
                const channelType = message.channel?.type || event.channel?.type || 'whatsapp';
                const platform = mapBirdChannelToPlatform(channelType);

                // The platformAccountId for Bird is the channel ID (used to look up the client service in DB)
                const platformAccountId = message.channel?.id || event.channel?.id || 'bird_default';

                const contactId = sender.id || sender.identifierValue || birdConversationId;
                const contactName = sender.displayName || sender.name || 'Sin nombre';
                const contactPhone = sender.identifierValue || '';

                // Extract message body
                const body = message.body || {};
                let { content: messageContent, type: messageType, audioUrl } = extractBirdMessageContent(body);

                if (!messageContent && !audioUrl) continue;

                // ── Pass to the existing AI pipeline ──────────────────────────────────────
                // We re-use processWebhookMessage with an adapter so Bird conversations
                // are stored and served the same way as Meta messages.
                await processWebhookMessage({
                    platform,
                    platformAccountId,
                    contactId,
                    contactName,
                    contactPhone,
                    message: messageContent,
                    messageType,
                    messageId: message.id,
                    timestamp: message.createdAt || Date.now(),
                    audioUrl: audioUrl || null,
                    // birdConversationId is stored so we can reply back via Bird API
                    birdConversationId,
                });

            } catch (eventErr) {
                console.error('[Bird] Error procesando evento:', eventErr.message);
            }
        }
    } catch (err) {
        console.error('[Bird] Error general en webhook:', err.message);
    }
};

// ─── VERIFICATION: Bird may send a GET ping to confirm the webhook URL ─────────
const verifyBirdWebhook = (req, res) => {
    // Bird echoes back a challenge in some integrations
    const challenge = req.query.challenge || 'ok';
    res.status(200).send(challenge);
};

module.exports = {
    handleBirdWebhook,
    verifyBirdWebhook,
};
