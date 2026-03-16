/**
 * B2B Web Admin Controller
 * 
 * CRUD operations for Agente Web configuration:
 * - Web config (widget settings, system prompt)
 * - Scrape URLs management + trigger scraping
 * - OAuth config
 * - API endpoints (coverage, lead submission)
 * - Conversations list + details
 */

const { query } = require('../config/database');
const { scrapeAndStore } = require('../services/b2bWebScraperService');
const { indexScrapedContent, indexUploadedFile } = require('../services/b2bWebEmbeddingService');
const { runAgenticScrape } = require('../services/b2bWebCrawlerService');
const { saveOAuthConfig, getOAuthConfig, testConnection } = require('../services/b2bWebOAuthService');
const { encrypt } = require('../utils/encryption');
const pdfParse = require('pdf-parse');
const path = require('path');

// ─── Web Config ────────────────────────────────────────────────

async function getWebConfig(req, res) {
    try {
        const { clientId } = req.params;
        const result = await query(
            'SELECT * FROM b2b_web_configs WHERE b2b_client_id = $1',
            [clientId]
        );

        if (!result.rows[0]) {
            // Auto-create default config
            const newResult = await query(
                `INSERT INTO b2b_web_configs (b2b_client_id) VALUES ($1) RETURNING *`,
                [clientId]
            );
            return res.json({ success: true, data: newResult.rows[0] });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[B2B Web Admin] getWebConfig error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function updateWebConfig(req, res) {
    try {
        const { clientId } = req.params;
        const { welcome_message, widget_color, widget_position, widget_delay_seconds, system_prompt, google_maps_api_key, scraping_enabled } = req.body;

        // Upsert config
        const existing = await query('SELECT id FROM b2b_web_configs WHERE b2b_client_id = $1', [clientId]);

        if (existing.rows[0]) {
            const updates = [];
            const values = [];
            let idx = 1;

            if (welcome_message !== undefined) { updates.push(`welcome_message = $${idx++}`); values.push(welcome_message); }
            if (widget_color !== undefined) { updates.push(`widget_color = $${idx++}`); values.push(widget_color); }
            if (widget_position !== undefined) { updates.push(`widget_position = $${idx++}`); values.push(widget_position); }
            if (widget_delay_seconds !== undefined) { updates.push(`widget_delay_seconds = $${idx++}`); values.push(widget_delay_seconds); }
            if (system_prompt !== undefined) { updates.push(`system_prompt = $${idx++}`); values.push(system_prompt); }
            if (google_maps_api_key !== undefined) { updates.push(`google_maps_api_key = $${idx++}`); values.push(google_maps_api_key); }
            if (scraping_enabled !== undefined) { updates.push(`scraping_enabled = $${idx++}`); values.push(scraping_enabled); }
            updates.push('updated_at = CURRENT_TIMESTAMP');

            values.push(clientId);
            const result = await query(
                `UPDATE b2b_web_configs SET ${updates.join(', ')} WHERE b2b_client_id = $${idx} RETURNING *`,
                values
            );
            return res.json({ success: true, data: result.rows[0] });
        } else {
            const result = await query(
                `INSERT INTO b2b_web_configs (b2b_client_id, welcome_message, widget_color, widget_position, widget_delay_seconds, system_prompt, google_maps_api_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [clientId, welcome_message, widget_color, widget_position, widget_delay_seconds, system_prompt, google_maps_api_key]
            );
            return res.json({ success: true, data: result.rows[0] });
        }
    } catch (error) {
        console.error('[B2B Web Admin] updateWebConfig error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── Scrape URLs ───────────────────────────────────────────────

async function listScrapeUrls(req, res) {
    try {
        const { clientId } = req.params;
        const result = await query(
            'SELECT * FROM b2b_web_scrape_urls WHERE b2b_client_id = $1 ORDER BY created_at',
            [clientId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[B2B Web Admin] listScrapeUrls error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function addScrapeUrl(req, res) {
    try {
        const { clientId } = req.params;
        const { url, label } = req.body;

        if (!url) {
            return res.status(400).json({ success: false, error: 'url is required' });
        }

        const result = await query(
            `INSERT INTO b2b_web_scrape_urls (b2b_client_id, url, label)
       VALUES ($1, $2, $3) RETURNING *`,
            [clientId, url, label || url]
        );

        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[B2B Web Admin] addScrapeUrl error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function deleteScrapeUrl(req, res) {
    try {
        const { urlId } = req.params;

        // Delete associated knowledge chunks first (table may not exist if pgvector unavailable)
        try { await query('DELETE FROM b2b_web_knowledge_chunks WHERE scrape_url_id = $1', [urlId]); } catch { /* table may not exist */ }
        await query('DELETE FROM b2b_web_scrape_urls WHERE id = $1', [urlId]);

        res.json({ success: true, data: { id: urlId, deleted: true } });
    } catch (error) {
        console.error('[B2B Web Admin] deleteScrapeUrl error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function triggerScrape(req, res) {
    try {
        const { clientId, urlId } = req.params;

        const urlResult = await query(
            'SELECT id, url FROM b2b_web_scrape_urls WHERE id = $1 AND b2b_client_id = $2',
            [urlId, clientId]
        );

        if (!urlResult.rows[0]) {
            return res.status(404).json({ success: false, error: 'URL not found' });
        }

        const { url } = urlResult.rows[0];

        // Scrape + store (async response — don't wait for full indexing)
        res.json({ success: true, message: 'Scraping started', url });

        // Run scraping in background
        try {
            const scrapeResult = await scrapeAndStore(urlId, clientId, url);

            // Index for RAG
            if (scrapeResult.extracted_text) {
                await indexScrapedContent(clientId, urlId, scrapeResult.extracted_text);
            }

            console.log(`[B2B Web Admin] Scrape + index complete for ${url}`);
        } catch (e) {
            console.error(`[B2B Web Admin] Background scrape failed for ${url}:`, e.message);
        }
    } catch (error) {
        console.error('[B2B Web Admin] triggerScrape error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function triggerAgenticScrape(req, res) {
    try {
        const { clientId, urlId } = req.params;

        const urlResult = await query(
            'SELECT id, url FROM b2b_web_scrape_urls WHERE id = $1 AND b2b_client_id = $2',
            [urlId, clientId]
        );

        if (!urlResult.rows[0]) {
            return res.status(404).json({ success: false, error: 'URL not found' });
        }

        const { url } = urlResult.rows[0];

        // Start agentic loop in background
        res.json({ success: true, message: 'Agentic scraping started', url });

        try {
            await runAgenticScrape(url, clientId);
            console.log(`[B2B Web Admin] Agentic scrape complete for ${url}`);
            
            // Update status to 'done' (Simple integration for now)
            await query(
                'UPDATE b2b_web_scrape_urls SET scrape_status = $1, last_scraped_at = CURRENT_TIMESTAMP WHERE id = $2',
                ['done', urlId]
            );
        } catch (e) {
            console.error(`[B2B Web Admin] Agentic scrape failed for ${url}:`, e.message);
        }
    } catch (error) {
        console.error('[B2B Web Admin] triggerAgenticScrape error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── OAuth Config ──────────────────────────────────────────────

async function getOAuth(req, res) {
    try {
        const { clientId } = req.params;
        const config = await getOAuthConfig(clientId);
        res.json({ success: true, data: config });
    } catch (error) {
        console.error('[B2B Web Admin] getOAuth error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function updateOAuth(req, res) {
    try {
        const { clientId } = req.params;
        const { token_url, client_id, client_secret, grant_type } = req.body;

        if (!token_url) {
            return res.status(400).json({ success: false, error: 'token_url is required' });
        }

        await saveOAuthConfig(clientId, { token_url, client_id, client_secret, grant_type });

        const config = await getOAuthConfig(clientId);
        res.json({ success: true, data: config });
    } catch (error) {
        console.error('[B2B Web Admin] updateOAuth error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function testOAuth(req, res) {
    try {
        const { clientId } = req.params;
        const result = await testConnection(clientId);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('[B2B Web Admin] testOAuth error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── API Endpoints ─────────────────────────────────────────────

async function listApiEndpoints(req, res) {
    try {
        const { clientId } = req.params;
        const result = await query(
            'SELECT * FROM b2b_web_api_endpoints WHERE b2b_client_id = $1 ORDER BY endpoint_type',
            [clientId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[B2B Web Admin] listApiEndpoints error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function upsertApiEndpoint(req, res) {
    try {
        const { clientId } = req.params;
        const { endpoint_type, url, http_method, channel_id } = req.body;

        if (!endpoint_type || !url) {
            return res.status(400).json({ success: false, error: 'endpoint_type and url are required' });
        }

        if (!['coverage_check', 'lead_submit'].includes(endpoint_type)) {
            return res.status(400).json({ success: false, error: "endpoint_type must be 'coverage_check' or 'lead_submit'" });
        }

        // Upsert by client + type
        const existing = await query(
            'SELECT id FROM b2b_web_api_endpoints WHERE b2b_client_id = $1 AND endpoint_type = $2',
            [clientId, endpoint_type]
        );

        let result;
        if (existing.rows[0]) {
            result = await query(
                `UPDATE b2b_web_api_endpoints SET url = $1, http_method = $2, channel_id = $3 WHERE id = $4 RETURNING *`,
                [url, http_method || 'POST', channel_id || null, existing.rows[0].id]
            );
        } else {
            result = await query(
                `INSERT INTO b2b_web_api_endpoints (b2b_client_id, endpoint_type, url, http_method, channel_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [clientId, endpoint_type, url, http_method || 'POST', channel_id || null]
            );
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[B2B Web Admin] upsertApiEndpoint error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function deleteApiEndpoint(req, res) {
    try {
        const { endpointId } = req.params;
        await query('DELETE FROM b2b_web_api_endpoints WHERE id = $1', [endpointId]);
        res.json({ success: true, data: { id: endpointId, deleted: true } });
    } catch (error) {
        console.error('[B2B Web Admin] deleteApiEndpoint error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── Conversations ─────────────────────────────────────────────

async function listConversations(req, res) {
    try {
        const { clientId } = req.params;
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE c.b2b_client_id = $1';
        const params = [clientId];
        let idx = 2;

        if (status) {
            whereClause += ` AND c.status = $${idx++}`;
            params.push(status);
        }

        params.push(limit, offset);

        const result = await query(
            `SELECT c.*, 
              (SELECT COUNT(*) FROM b2b_web_messages m WHERE m.conversation_id = c.id) as message_count
       FROM b2b_web_conversations c
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
            params
        );

        const countResult = await query(
            `SELECT COUNT(*) as total FROM b2b_web_conversations c ${whereClause}`,
            params.slice(0, status ? 2 : 1)
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
        console.error('[B2B Web Admin] listConversations error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function getConversation(req, res) {
    try {
        const { convId } = req.params;

        const convResult = await query(
            'SELECT * FROM b2b_web_conversations WHERE id = $1',
            [convId]
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
        console.error('[B2B Web Admin] getConversation error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

// ─── Uploaded Files (Knowledge Base) ──────────────────────────

async function listUploadedFiles(req, res) {
    try {
        const { clientId } = req.params;
        const result = await query(
            'SELECT id, original_name, mime_type, file_size, status, created_at FROM b2b_web_uploaded_files WHERE b2b_client_id = $1 ORDER BY created_at DESC',
            [clientId]
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[B2B Web Admin] listUploadedFiles error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function uploadFile(req, res) {
    try {
        const { clientId } = req.params;

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No se envió ningún archivo' });
        }

        const { originalname, mimetype, size, buffer } = req.file;
        const ext = path.extname(originalname).toLowerCase();

        // Extract text based on file type
        let extractedText = '';

        if (ext === '.pdf') {
            const pdfData = await pdfParse(buffer);
            extractedText = pdfData.text;
        } else if (ext === '.txt' || ext === '.csv' || ext === '.md') {
            extractedText = buffer.toString('utf-8');
        } else if (ext === '.docx') {
            // mammoth is optional — try dynamic import
            try {
                const mammoth = require('mammoth');
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value;
            } catch {
                return res.status(400).json({ success: false, error: 'Para archivos .docx se requiere instalar mammoth: npm install mammoth' });
            }
        } else {
            return res.status(400).json({ success: false, error: 'Formato no soportado. Usa PDF, TXT, DOCX, CSV o MD.' });
        }

        if (!extractedText || extractedText.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'No se pudo extraer texto del archivo o está vacío' });
        }

        // Save file record
        const insertResult = await query(
            `INSERT INTO b2b_web_uploaded_files (b2b_client_id, original_name, mime_type, file_size, extracted_text, status)
             VALUES ($1, $2, $3, $4, $5, 'done') RETURNING id, original_name, mime_type, file_size, status, created_at`,
            [clientId, originalname, mimetype, size, extractedText]
        );

        const file = insertResult.rows[0];

        // Respond immediately
        res.status(201).json({ success: true, data: file });

        // Index for RAG in background
        try {
            await indexUploadedFile(clientId, file.id, extractedText);
            console.log(`[B2B Web Admin] File indexed: ${originalname} (${file.id})`);
        } catch (e) {
            console.error(`[B2B Web Admin] Background indexing failed for ${originalname}:`, e.message);
            await query("UPDATE b2b_web_uploaded_files SET status = 'error' WHERE id = $1", [file.id]);
        }

    } catch (error) {
        console.error('[B2B Web Admin] uploadFile error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

async function deleteUploadedFile(req, res) {
    try {
        const { fileId } = req.params;

        // Delete associated knowledge chunks (table may not exist if pgvector unavailable)
        try { await query('DELETE FROM b2b_web_knowledge_chunks WHERE scrape_url_id = $1', [fileId]); } catch { /* table may not exist */ }
        // Delete the file record
        await query('DELETE FROM b2b_web_uploaded_files WHERE id = $1', [fileId]);

        res.json({ success: true, data: { id: fileId, deleted: true } });
    } catch (error) {
        console.error('[B2B Web Admin] deleteUploadedFile error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

module.exports = {
    getWebConfig,
    updateWebConfig,
    listScrapeUrls,
    addScrapeUrl,
    deleteScrapeUrl,
    triggerScrape,
    triggerAgenticScrape,
    getOAuth,
    updateOAuth,
    testOAuth,
    listApiEndpoints,
    upsertApiEndpoint,
    deleteApiEndpoint,
    listConversations,
    getConversation,
    listUploadedFiles,
    uploadFile,
    deleteUploadedFile,
};
