const { query } = require('../config/database');
const { addJob, isQueueReady } = require('../queues/b2bQueue');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ─── B2B Webhook Controller ────────────────────────────────────
// Receives call audio URLs and email JSON from external systems.
// Creates interactions and enqueues them for async processing.

/**
 * Download the first 64KB of an audio URL and return SHA-256 hex.
 * Used for content-based deduplication independent of filename/source_id.
 * Falls back to null if the URL is not reachable or not HTTP/HTTPS.
 */
async function computeAudioHashFromUrl(audioUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(audioUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      const MAX_BYTES = 65536; // 64 KB sample

      const req = lib.get(audioUrl, { timeout: 8000 }, (res) => {
        const hash = crypto.createHash('sha256');
        let received = 0;
        res.on('data', (chunk) => {
          const remaining = MAX_BYTES - received;
          if (remaining <= 0) return;
          hash.update(chunk.slice(0, Math.min(chunk.length, remaining)));
          received += chunk.length;
          if (received >= MAX_BYTES) res.destroy();
        });
        res.on('end', () => resolve(hash.digest('hex')));
        res.on('close', () => resolve(hash.digest('hex')));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

/**
 * POST /api/v1/b2b/webhook/:clientId/call
 * Receive a call audio URL for transcription and analysis.
 * Body: { audio_url, area_id, source_id? }
 */
async function receiveCall(req, res) {
  try {
    const { clientId } = req.params;
    const { audio_url, area_id, source_id } = req.body;

    if (!audio_url || !area_id) {
      return res.status(400).json({
        success: false,
        error: 'audio_url and area_id are required'
      });
    }

    // Verify the area belongs to this client
    const areaCheck = await query(
      'SELECT id FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2 AND is_active = true',
      [area_id, clientId]
    );
    if (!areaCheck.rows[0]) {
      return res.status(404).json({
        success: false,
        error: 'Area not found or does not belong to this client'
      });
    }

    // Idempotencia nivel 1: source_id exact match
    if (source_id) {
      const existing = await query(
        `SELECT id, status FROM b2b_interactions
         WHERE b2b_area_id = $1 AND source_id = $2
         AND status NOT IN ('exportado', 'error_cola', 'error_transcripcion', 'error_filtro', 'error_analisis', 'error_reproceso')
         ORDER BY created_at DESC LIMIT 1`,
        [area_id, source_id]
      );
      if (existing.rows[0]) {
        return res.status(200).json({
          success: true,
          data: {
            interaction_id: existing.rows[0].id,
            status: existing.rows[0].status,
            already_processed: false,
            message: 'Call already received (idempotent); use this interaction_id'
          }
        });
      }
    }

    // Idempotencia nivel 2: audio content hash (detects same file with different name/source_id)
    const audioHash = await computeAudioHashFromUrl(audio_url);
    if (audioHash) {
      const hashMatch = await query(
        `SELECT id, status FROM b2b_interactions
         WHERE b2b_area_id = $1 AND audio_hash = $2
         AND status NOT IN ('error_cola', 'error_transcripcion', 'error_filtro', 'error_analisis', 'error_reproceso')
         ORDER BY created_at DESC LIMIT 1`,
        [area_id, audioHash]
      );
      if (hashMatch.rows[0]) {
        return res.status(200).json({
          success: true,
          data: {
            interaction_id: hashMatch.rows[0].id,
            status: hashMatch.rows[0].status,
            already_processed: true,
            message: 'Este audio ya fue evaluado anteriormente (contenido idéntico detectado)'
          }
        });
      }
    }

    // Create interaction with placeholder raw_text (will be replaced after transcription)
    const result = await query(
      `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status, audio_hash)
       VALUES ($1, 'call', $2, '[pendiente transcripción]', 'recibido', $3)
       RETURNING id`,
      [area_id, source_id || audio_url, audioHash]
    );
    const interactionId = result.rows[0].id;

    // Enqueue transcription job
    if (isQueueReady()) {
      await addJob('transcribe', { interactionId, audioUrl: audio_url });
    } else {
      // Fallback: mark as error if Redis unavailable
      await query(
        "UPDATE b2b_interactions SET status = 'error_cola' WHERE id = $1",
        [interactionId]
      );
      console.warn(`[B2B Webhook] Redis unavailable, interaction ${interactionId} stuck`);
    }

    res.status(201).json({
      success: true,
      data: {
        interaction_id: interactionId,
        status: 'recibido',
        message: 'Call received and queued for transcription'
      }
    });

  } catch (error) {
    console.error('[B2B Webhook] receiveCall error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/webhook/:clientId/email
 * Receive an email for classification and analysis.
 * Body: { from, subject, body, date?, id?, area_id }
 */
async function receiveEmail(req, res) {
  try {
    const { clientId } = req.params;
    const { from, subject, body, date, id: sourceId, area_id } = req.body;

    if (!body || !area_id) {
      return res.status(400).json({
        success: false,
        error: 'body and area_id are required'
      });
    }

    // Verify the area belongs to this client
    const areaCheck = await query(
      'SELECT id FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2 AND is_active = true',
      [area_id, clientId]
    );
    if (!areaCheck.rows[0]) {
      return res.status(404).json({
        success: false,
        error: 'Area not found or does not belong to this client'
      });
    }

    // Compose raw_text from email fields
    const rawText = [
      from ? `De: ${from}` : '',
      date ? `Fecha: ${date}` : '',
      subject ? `Asunto: ${subject}` : '',
      '',
      body
    ].filter(Boolean).join('\n');

    // Idempotencia: si ya existe una interacción con mismo area_id + source_id y aún en proceso, devolver esa
    if (sourceId) {
      const existing = await query(
        `SELECT id, status FROM b2b_interactions
         WHERE b2b_area_id = $1 AND source_id = $2
         AND status NOT IN ('exportado', 'error_cola', 'error_transcripcion', 'error_filtro', 'error_analisis', 'error_reproceso')
         ORDER BY created_at DESC LIMIT 1`,
        [area_id, sourceId]
      );
      if (existing.rows[0]) {
        return res.status(200).json({
          success: true,
          data: {
            interaction_id: existing.rows[0].id,
            status: existing.rows[0].status,
            message: 'Email already received (idempotent); use this interaction_id'
          }
        });
      }
    }

    // Create interaction
    const result = await query(
      `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status)
       VALUES ($1, 'email', $2, $3, 'recibido')
       RETURNING id`,
      [area_id, sourceId || null, rawText]
    );
    const interactionId = result.rows[0].id;

    // Enqueue filter job (skip transcription — email is already text)
    if (isQueueReady()) {
      await addJob('filter', { interactionId });
    } else {
      await query(
        "UPDATE b2b_interactions SET status = 'error_cola' WHERE id = $1",
        [interactionId]
      );
      console.warn(`[B2B Webhook] Redis unavailable, interaction ${interactionId} stuck`);
    }

    res.status(201).json({
      success: true,
      data: {
        interaction_id: interactionId,
        status: 'recibido',
        message: 'Email received and queued for processing'
      }
    });

  } catch (error) {
    console.error('[B2B Webhook] receiveEmail error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = { receiveCall, receiveEmail };
