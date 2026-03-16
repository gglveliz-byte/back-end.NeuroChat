/**
 * B2B Web Client Controller
 * 
 * Read-only endpoints for the Agente Web client panel dashboard
 * and conversations history list.
 */

const { query } = require('../config/database');

// ─── Web Client Config ───────────────────────────────────────────────

async function getClientConfig(req, res) {
    try {
        const clientId = req.b2bClient.id;
        const result = await query(
            'SELECT welcome_message, widget_color, widget_position FROM b2b_web_configs WHERE b2b_client_id = $1',
            [clientId]
        );
        res.json({ success: true, data: result.rows[0] || {} });
    } catch (error) {
        console.error('[B2B Web Client] getClientConfig error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function updateClientConfig(req, res) {
    try {
        const clientId = req.b2bClient.id;
        const { widget_color, widget_position, welcome_message } = req.body;

        // Upsert config safe fields for the client
        const existing = await query('SELECT id FROM b2b_web_configs WHERE b2b_client_id = $1', [clientId]);

        let result;
        if (existing.rows[0]) {
            result = await query(
                `UPDATE b2b_web_configs SET widget_color = $1, widget_position = $2, welcome_message = COALESCE($4, welcome_message), updated_at = CURRENT_TIMESTAMP WHERE b2b_client_id = $3 RETURNING welcome_message, widget_color, widget_position`,
                [widget_color || '#10b981', widget_position || 'right', clientId, welcome_message]
            );
        } else {
            result = await query(
                `INSERT INTO b2b_web_configs (b2b_client_id, widget_color, widget_position, welcome_message) VALUES ($1, $2, $3, $4) RETURNING welcome_message, widget_color, widget_position`,
                [clientId, widget_color || '#10b981', widget_position || 'right', welcome_message || 'Hola! ¿En qué puedo ayudarte?']
            );
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[B2B Web Client] updateClientConfig error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── Dashboard Stats ───────────────────────────────────────────────

async function getDashboardStats(req, res) {
    try {
        const clientId = req.b2bClient.id; // from b2bAuthenticate middleware

        // Count total conversations (only those where the visitor actually sent a message)
        const convRes = await query(
            `SELECT COUNT(*) as count FROM b2b_web_conversations c 
             WHERE c.b2b_client_id = $1 
             AND EXISTS (SELECT 1 FROM b2b_web_messages m WHERE m.conversation_id = c.id AND m.role = 'user')`,
            [clientId]
        );
        const conversations = parseInt(convRes.rows[0].count) || 0;

        // Count leads (where customer information was submitted via submit_lead)
        const leadsRes = await query(
            'SELECT COUNT(*) as count FROM b2b_web_conversations WHERE b2b_client_id = $1 AND customer_name IS NOT NULL',
            [clientId]
        );
        const leads = parseInt(leadsRes.rows[0].count) || 0;

        // Count coverage checks (where coverage_status is not null)
        const coverageRes = await query(
            'SELECT COUNT(*) as count FROM b2b_web_conversations WHERE b2b_client_id = $1 AND coverage_status IS NOT NULL',
            [clientId]
        );
        const coverage_checks = parseInt(coverageRes.rows[0].count) || 0;

        res.json({
            success: true,
            data: {
                conversations,
                leads,
                coverage_checks
            }
        });
    } catch (error) {
        console.error('[B2B Web Client] getDashboardStats error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── Conversations List ────────────────────────────────────────────

async function getClientConversations(req, res) {
    try {
        const clientId = req.b2bClient.id;
        const { page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;

        const result = await query(
            `SELECT c.*, 
              (SELECT COUNT(*) FROM b2b_web_messages m WHERE m.conversation_id = c.id) as message_count,
              CASE WHEN c.customer_name IS NOT NULL THEN true ELSE false END as lead_submitted,
              c.location_lat as user_lat,
              c.location_lng as user_lng
           FROM b2b_web_conversations c
           WHERE c.b2b_client_id = $1
           AND EXISTS (SELECT 1 FROM b2b_web_messages m2 WHERE m2.conversation_id = c.id AND m2.role = 'user')
           ORDER BY c.created_at DESC
           LIMIT $2 OFFSET $3`,
            [clientId, limit, offset]
        );

        const countResult = await query(
            `SELECT COUNT(*) as total FROM b2b_web_conversations c 
             WHERE c.b2b_client_id = $1 
             AND EXISTS (SELECT 1 FROM b2b_web_messages m2 WHERE m2.conversation_id = c.id AND m2.role = 'user')`,
            [clientId]
        );

        res.json({
            success: true,
            data: result.rows,
            pagination: {
                total: parseInt(countResult.rows[0].total),
                page: parseInt(page),
                limit: parseInt(limit),
            },
        });
    } catch (error) {
        console.error('[B2B Web Client] getClientConversations error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function getClientConversationDetails(req, res) {
    try {
        const clientId = req.b2bClient.id;
        const { convId } = req.params;

        const convResult = await query(
            'SELECT * FROM b2b_web_conversations WHERE id = $1 AND b2b_client_id = $2',
            [convId, clientId]
        );

        if (!convResult.rows[0]) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }

        const messages = await query(
            'SELECT * FROM b2b_web_messages WHERE conversation_id = $1 ORDER BY created_at',
            [convId]
        );

        res.json({
            success: true,
            data: {
                conversation: convResult.rows[0],
                messages: messages.rows,
            },
        });
    } catch (error) {
        console.error('[B2B Web Client] getClientConversationDetails error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

module.exports = {
    getDashboardStats,
    getClientConversations,
    getClientConfig,
    updateClientConfig,
    getClientConversationDetails
};
