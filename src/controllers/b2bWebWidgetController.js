/**
 * B2B Web Widget Controller
 * 
 * Public API endpoints for the chat widget embedded on client websites.
 * No admin auth required — identified by clientId.
 */

const { query } = require('../config/database');
const { processMessage } = require('../services/b2bWebChatService');

/**
 * GET /api/v1/b2b-web/widget/:clientId/config
 * Returns widget configuration for the embedded chat.
 */
async function getWidgetConfig(req, res) {
    try {
        const { clientId } = req.params;

        // Verify this is an agente_web client
        const clientResult = await query(
            "SELECT id, company_name, status, client_type FROM b2b_clients WHERE id = $1",
            [clientId]
        );

        if (!clientResult.rows[0]) {
            return res.status(404).json({ success: false, error: 'Client not found' });
        }

        if (clientResult.rows[0].status !== 'active') {
            return res.status(403).json({ success: false, error: 'Client is inactive' });
        }

        const configResult = await query(
            'SELECT welcome_message, widget_color, widget_position, widget_delay_seconds, google_maps_api_key FROM b2b_web_configs WHERE b2b_client_id = $1',
            [clientId]
        );

        const config = configResult.rows[0] || {};

        res.json({
            success: true,
            data: {
                company_name: clientResult.rows[0].company_name,
                welcome_message: config.welcome_message || 'Hola! ¿En qué puedo ayudarte?',
                widget_color: config.widget_color || '#0ea5e9',
                widget_position: config.widget_position || 'right',
                widget_delay_seconds: config.widget_delay_seconds || 3,
                google_maps_api_key: config.google_maps_api_key || null,
            },
        });
    } catch (error) {
        console.error('[B2B Web Widget] getConfig error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

/**
 * POST /api/v1/b2b-web/widget/:clientId/conversations
 * Start a new chat conversation.
 * Body: { visitor_id? }
 */
async function startConversation(req, res) {
    try {
        const { clientId } = req.params;
        const { visitor_id } = req.body;

        // Verify client
        const clientCheck = await query(
            "SELECT id FROM b2b_clients WHERE id = $1 AND status = 'active'",
            [clientId]
        );
        if (!clientCheck.rows[0]) {
            return res.status(404).json({ success: false, error: 'Client not found or inactive' });
        }

        // Create conversation
        const result = await query(
            `INSERT INTO b2b_web_conversations (b2b_client_id, visitor_id)
       VALUES ($1, $2) RETURNING id, created_at`,
            [clientId, visitor_id || null]
        );

        const conversation = result.rows[0];

        // Insert welcome message
        const configResult = await query(
            'SELECT welcome_message FROM b2b_web_configs WHERE b2b_client_id = $1',
            [clientId]
        );
        const welcomeMessage = configResult.rows[0]?.welcome_message || 'Hola! ¿En qué puedo ayudarte?';

        await query(
            `INSERT INTO b2b_web_messages (conversation_id, role, content)
       VALUES ($1, 'assistant', $2)`,
            [conversation.id, welcomeMessage]
        );

        res.status(201).json({
            success: true,
            data: {
                conversation_id: conversation.id,
                welcome_message: welcomeMessage,
            },
        });
    } catch (error) {
        console.error('[B2B Web Widget] startConversation error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

/**
 * POST /api/v1/b2b-web/widget/:clientId/conversations/:convId/messages
 * Send a user message and get AI response.
 * Body: { message }
 */
async function sendMessage(req, res) {
    try {
        const { clientId, convId } = req.params;
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ success: false, error: 'message is required' });
        }

        // Verify conversation belongs to this client
        const convCheck = await query(
            "SELECT id FROM b2b_web_conversations WHERE id = $1 AND b2b_client_id = $2 AND status = 'active'",
            [convId, clientId]
        );
        if (!convCheck.rows[0]) {
            return res.status(404).json({ success: false, error: 'Conversation not found or inactive' });
        }

        // Process message through AI
        const result = await processMessage(clientId, convId, message.trim());

        res.json({
            success: true,
            data: {
                response: result.response,
                metadata: result.metadata || {},
            },
        });
    } catch (error) {
        console.error('[B2B Web Widget] sendMessage error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

/**
 * GET /api/v1/b2b-web/widget/:clientId/conversations/:convId/messages
 * Get conversation history.
 */
async function getMessages(req, res) {
    try {
        const { clientId, convId } = req.params;

        const convCheck = await query(
            'SELECT id FROM b2b_web_conversations WHERE id = $1 AND b2b_client_id = $2',
            [convId, clientId]
        );
        if (!convCheck.rows[0]) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }

        const result = await query(
            'SELECT id, role, content, metadata, created_at FROM b2b_web_messages WHERE conversation_id = $1 ORDER BY created_at',
            [convId]
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[B2B Web Widget] getMessages error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

/**
 * POST /api/v1/b2b-web/widget/:clientId/conversations/:convId/location
 * Save customer location from Google Maps picker.
 * Body: { lat, lng, city?, address? }
 */
async function saveLocation(req, res) {
    try {
        const { convId } = req.params;
        const { lat, lng, city, address } = req.body;

        if (!lat || !lng) {
            return res.status(400).json({ success: false, error: 'lat and lng are required' });
        }

        await query(
            `UPDATE b2b_web_conversations 
       SET location_lat = $1, location_lng = $2, location_city = $3, location_address = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
            [lat, lng, city || null, address || null, convId]
        );

        res.json({ success: true, data: { lat, lng, city, address } });
    } catch (error) {
        console.error('[B2B Web Widget] saveLocation error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

module.exports = {
    getWidgetConfig,
    startConversation,
    sendMessage,
    getMessages,
    saveLocation,
};
