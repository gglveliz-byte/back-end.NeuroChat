const bcrypt = require('bcryptjs');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { query } = require('../config/database');
const { generateB2BToken } = require('../middlewares/b2bAuth');
const { generateExcel } = require('../services/b2bExportService');
const { addJob, isQueueReady } = require('../queues/b2bQueue');
const { transcribeAudioFromBufferFull, diarizeTranscription } = require('../services/b2bTranscriptionService');
const { stepFilter, stepAnalyze, getFilterAgent, accumulateFeedback } = require('../services/b2bPipelineService');

// ─── B2B Client Controller ─────────────────────────────────────
// Endpoints for B2B client panel: login, interactions, review, export.
// Protected by b2bAuthenticate middleware (except login).

/**
 * POST /api/v1/b2b/auth/login
 * Authenticate a B2B client
 * Body: { email, password }
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'email and password are required'
      });
    }

    const result = await query(
      'SELECT id, company_name, contact_name, email, password_hash, ai_provider, ai_model, client_type, status FROM b2b_clients WHERE email = $1',
      [email]
    );

    const client = result.rows[0];
    if (!client) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas',
        code: 'B2B_INVALID_CREDENTIALS'
      });
    }

    if (client.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Cuenta no activa',
        code: 'B2B_ACCOUNT_INACTIVE'
      });
    }

    const passwordValid = await bcrypt.compare(password, client.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas',
        code: 'B2B_INVALID_CREDENTIALS'
      });
    }

    const token = generateB2BToken(client);

    res.json({
      success: true,
      data: {
        token,
        client: {
          id: client.id,
          company_name: client.company_name,
          contact_name: client.contact_name,
          email: client.email,
          client_type: client.client_type || 'agente_calidad',
          status: client.status
        }
      }
    });

  } catch (error) {
    console.error('[B2B Client] login error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/interactions
 * List interactions for the authenticated B2B client
 * Query: ?area_id=&status=&page=1&limit=20
 */
async function listInteractions(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    // Accept both 'area' and 'area_id' for compatibility with frontend guide
    const { area, area_id, status, page = 1, limit = 20 } = req.query;
    const areaFilter = area || area_id;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build query with optional filters
    let whereClause = 'WHERE a.b2b_client_id = $1';
    const params = [b2bClientId];
    let paramIndex = 2;

    if (areaFilter) {
      whereClause += ` AND i.b2b_area_id = $${paramIndex++}`;
      params.push(areaFilter);
    }
    if (status) {
      whereClause += ` AND i.status = $${paramIndex++}`;
      params.push(status);
    }

    // Save paramIndex before adding limit/offset for count query
    const filterParamCount = params.length;

    // Main query with JOIN for area_name and calificacion extraction
    params.push(parseInt(limit), offset);
    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex;
    const result = await query(
      `SELECT i.*, a.display_name AS area_name,
              (i.agent_result->>'calificacion')::numeric AS calificacion,
              (i.agent_result->>'porcentaje')::numeric AS porcentaje
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    // Count total for pagination (without limit/offset params)
    const countParams = params.slice(0, filterParamCount);
    const countResult = await query(
      `SELECT COUNT(*) as total
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       ${whereClause}`,
      countParams
    );
    const total = parseInt(countResult.rows[0].total);

    // Get available areas for filter dropdown
    const areasResult = await query(
      'SELECT id, display_name FROM b2b_areas WHERE b2b_client_id = $1 AND is_active = true ORDER BY display_name',
      [b2bClientId]
    );

    res.json({
      success: true,
      data: {
        interactions: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        filters: {
          areas: areasResult.rows
        }
      }
    });

  } catch (error) {
    console.error('[B2B Client] listInteractions error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/areas
 * List areas for the authenticated B2B client
 */
async function getAreas(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;

    const areasResult = await query(
      `SELECT
          a.id,
          a.display_name,
          a.name,
          a.is_active,
          a.processing_mode,
          (SELECT COUNT(*) FROM b2b_agents WHERE b2b_area_id = a.id) as agents_count,
          (SELECT COUNT(*) FROM b2b_interactions WHERE b2b_area_id = a.id) as interactions_count
       FROM b2b_areas a
       WHERE a.b2b_client_id = $1
       ORDER BY a.display_name`,
      [b2bClientId]
    );

    res.json({
      success: true,
      data: areasResult.rows
    });
  } catch (error) {
    console.error('[B2B Client] getAreas error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/interactions/:id
 * Get full detail of a single interaction
 */
async function getInteraction(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;

    const result = await query(
      `SELECT i.*, a.display_name AS area_name, a.name AS area_code
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('[B2B Client] getInteraction error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/review/queue
 * Get interactions pending human review (status = 'en_revision')
 * Query: ?area_id=&page=1&limit=20
 */
async function getReviewQueue(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { area_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Accept both 'area' and 'area_id'
    const areaFilter = req.query.area || area_id;

    let whereClause = "WHERE a.b2b_client_id = $1 AND i.status = 'en_revision'";
    const params = [b2bClientId];
    let paramIndex = 2;

    if (areaFilter) {
      whereClause += ` AND i.b2b_area_id = $${paramIndex++}`;
      params.push(areaFilter);
    }

    const filterParamCount = params.length;

    params.push(parseInt(limit), offset);
    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex;
    const result = await query(
      `SELECT i.*, a.display_name AS area_name,
              (i.agent_result->>'calificacion')::numeric AS calificacion,
              (i.agent_result->>'porcentaje')::numeric AS porcentaje
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       ${whereClause}
       ORDER BY i.processed_at ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countParams = params.slice(0, filterParamCount);
    const countResult = await query(
      `SELECT COUNT(*) as total
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       ${whereClause}`,
      countParams
    );
    const totalPending = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: {
        total_pending: totalPending,
        interactions: result.rows
      }
    });

  } catch (error) {
    console.error('[B2B Client] getReviewQueue error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/review/:id/approve
 * Approve an interaction (move to 'aprobado')
 * Body: { reviewer }
 */
async function approveReview(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;
    const { reviewer } = req.body;

    // Verify interaction belongs to client and is in review
    const check = await query(
      `SELECT i.id, i.status
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );

    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    if (check.rows[0].status !== 'en_revision') {
      return res.status(400).json({
        success: false,
        error: `Cannot approve — current status is '${check.rows[0].status}', expected 'en_revision'`
      });
    }

    const result = await query(
      `UPDATE b2b_interactions
       SET status = 'aprobado', human_reviewer = $1, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, status, human_reviewer, reviewed_at`,
      [reviewer || req.b2bClient.contact_name, id]
    );

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('[B2B Client] approveReview error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/review/:id/reject
 * Reject an interaction with feedback → triggers reprocessing
 * Body: { reviewer, feedback }
 */
async function rejectReview(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;
    const { reviewer, feedback } = req.body;

    if (!feedback) {
      return res.status(400).json({
        success: false,
        error: 'feedback is required when rejecting'
      });
    }

    // Verify interaction belongs to client and is in review
    const check = await query(
      `SELECT i.id, i.status
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );

    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    if (check.rows[0].status !== 'en_revision') {
      return res.status(400).json({
        success: false,
        error: `Cannot reject — current status is '${check.rows[0].status}', expected 'en_revision'`
      });
    }

    // Update status and save feedback
    await query(
      `UPDATE b2b_interactions
       SET status = 'rechazado', human_reviewer = $1, human_feedback = $2, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [reviewer || req.b2bClient.contact_name, feedback, id]
    );

    // ─── Accumulate feedback into the assigned agent (permanent improvement) ───
    // Get the interaction's assigned_agent and area to find the agent record
    const interactionData = await query(
      `SELECT i.assigned_agent, i.b2b_area_id
       FROM b2b_interactions i WHERE i.id = $1`,
      [id]
    );
    if (interactionData.rows[0]?.assigned_agent) {
      const { assigned_agent, b2b_area_id } = interactionData.rows[0];
      await query(
        `UPDATE b2b_agents
         SET feedback_accumulated = COALESCE(feedback_accumulated, '') || E'\n- ' || $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE b2b_area_id = $2 AND name = $3 AND type = 'specialized'`,
        [feedback, b2b_area_id, assigned_agent]
      );
    }

    // Enqueue reprocessing
    await addJob('reprocess', { interactionId: id, humanFeedback: feedback });

    res.json({
      success: true,
      data: {
        id,
        status: 'rechazado',
        message: 'Interaction rejected and queued for reprocessing with feedback'
      }
    });

  } catch (error) {
    console.error('[B2B Client] rejectReview error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/export
 * Create an export record and return stats
 * Body: { area_id, date_from, date_to }
 */
async function createExport(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { area_id, date_from, date_to } = req.body;

    if (!area_id || !date_from || !date_to) {
      return res.status(400).json({
        success: false,
        error: 'area_id, date_from, and date_to are required'
      });
    }

    // Verify area belongs to client
    const areaCheck = await query(
      'SELECT id, display_name FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2',
      [area_id, b2bClientId]
    );
    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    // Count stats for the date range (timezone-aware: Ecuador is UTC-5)
    const statsResult = await query(
      `SELECT
         COUNT(*) as total_in_range,
         COUNT(*) FILTER (WHERE status = 'aprobado') as approved,
         COUNT(*) FILTER (WHERE status NOT IN ('aprobado', 'exportado')) as pending
       FROM b2b_interactions
       WHERE b2b_area_id = $1
         AND created_at >= ($2::date AT TIME ZONE 'America/Guayaquil')
         AND created_at < (($3::date + interval '1 day') AT TIME ZONE 'America/Guayaquil')`,
      [area_id, date_from, date_to]
    );
    const stats = {
      total_in_range: parseInt(statsResult.rows[0].total_in_range),
      approved: parseInt(statsResult.rows[0].approved),
      pending: parseInt(statsResult.rows[0].pending)
    };

    // Create export record
    const result = await query(
      `INSERT INTO b2b_exports (b2b_area_id, date_from, date_to, total_records, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, date_from, date_to, total_records, created_at`,
      [area_id, date_from, date_to, stats.approved, req.b2bClient.contact_name]
    );

    res.status(201).json({
      success: true,
      data: {
        export_id: result.rows[0].id,
        area_name: areaCheck.rows[0].display_name,
        date_from: result.rows[0].date_from,
        date_to: result.rows[0].date_to,
        total_records: result.rows[0].total_records,
        stats
      }
    });

  } catch (error) {
    console.error('[B2B Client] createExport error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/export/:exportId
 * Download Excel file for an export
 */
async function downloadExport(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { exportId } = req.params;

    // Get export record and verify ownership
    const exportResult = await query(
      `SELECT e.*, a.b2b_client_id, a.display_name as area_name
       FROM b2b_exports e
       JOIN b2b_areas a ON e.b2b_area_id = a.id
       WHERE e.id = $1 AND a.b2b_client_id = $2`,
      [exportId, b2bClientId]
    );

    if (!exportResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Export not found' });
    }

    const exportRecord = exportResult.rows[0];

    // Generate Excel in real time
    const { buffer, totalRecords, areaName } = await generateExcel(
      exportRecord.b2b_area_id,
      exportRecord.date_from,
      exportRecord.date_to
    );

    // Build filename
    const fileName = `Reporte_${areaName.replace(/[^a-zA-Z0-9]/g, '_')}_${exportRecord.date_from}_${exportRecord.date_to}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

  } catch (error) {
    console.error('[B2B Client] downloadExport error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/upload-audio
 * Upload an audio file (MP3/WAV) for provisional testing.
 * Transcribes directly, creates interaction, and runs pipeline.
 * Body (multipart): file, area_id
 */
async function uploadAudio(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { area_id, quality } = req.body;

    if (!area_id) {
      return res.status(400).json({ success: false, error: 'area_id is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    }

    // Verify area belongs to client
    const areaCheck = await query(
      'SELECT id, display_name FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2 AND is_active = true',
      [area_id, b2bClientId]
    );
    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    // Extract buffer and create SHA-256 hash (full file, more reliable than MD5)
    const audioBuffer = Buffer.from(req.file.buffer);
    const audio_hash = crypto.createHash('sha256').update(audioBuffer).digest('hex').substring(0, 64);

    // Check if this exact audio was already processed in this area
    const hashMatch = await query(
      `SELECT i.id, i.status, i.audio_filename,
              eh.agent_result AS cached_result
       FROM b2b_interactions i
       LEFT JOIN b2b_evaluation_history eh
         ON eh.audio_hash = i.audio_hash AND eh.b2b_area_id = i.b2b_area_id
       WHERE i.b2b_area_id = $1 AND i.audio_hash = $2
         AND i.status NOT IN ('error_cola', 'error_transcripcion', 'error_filtro', 'error_analisis', 'error_reproceso')
       ORDER BY i.created_at DESC LIMIT 1`,
      [area_id, audio_hash]
    );
    if (hashMatch.rows[0]) {
      const prev = hashMatch.rows[0];

      // Check if the agent's criteria changed since last evaluation
      let criteriaChanged = false;
      if (prev.cached_result) {
        const agentRow = await query(
          `SELECT evaluation_template FROM b2b_agents
           WHERE b2b_area_id = $1 AND is_active = true
           ORDER BY created_at DESC LIMIT 1`,
          [area_id]
        );
        const template = agentRow.rows[0]?.evaluation_template;
        if (template && template.trim().startsWith('[')) {
          try {
            const currentCriteria = JSON.parse(template);
            const prevCriterios = prev.cached_result.criterios || [];
            const currentNames = currentCriteria
              .filter(c => (c['Tipo de Error'] || '').toLowerCase() !== 'no aplica')
              .map(c => {
                const s = c['Criterio Específico'] || c['criterio específico'] || '';
                const g = c['Criterio a evaluar'] || c['criterio a evaluar'] || '';
                return (s && s.toLowerCase() !== 'no aplica') ? `${g} - ${s}`.toLowerCase().trim()
                  : String(c.Criterio || c.criterio || c.nombre || '').toLowerCase().trim();
              }).filter(Boolean);
            const prevNames = prevCriterios.map(c => String(c.nombre || c.Criterio || '').toLowerCase().trim()).filter(Boolean);
            const maxSize = Math.max(currentNames.length, prevNames.length);
            if (maxSize > 0) {
              let matches = 0;
              for (const cn of currentNames) {
                if (prevNames.some(pn => cn === pn || cn.includes(pn) || pn.includes(cn))) matches++;
              }
              if ((matches / maxSize) < 0.7) criteriaChanged = true;
            }
          } catch { /* ignore */ }
        }
      }

      // Only simulate pipeline if criteria haven't changed (cached result is still valid)
      if (!criteriaChanged && prev.cached_result) {
        // Create a fresh interaction so the user sees a new entry in the list
        const simResult = await query(
          `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status, audio_hash, audio_filename)
           VALUES ($1, 'call', $2, '[pendiente transcripcion]', 'recibido', $3, $4)
           RETURNING id`,
          [area_id, `upload_${req.file.originalname}`, audio_hash, req.file.originalname]
        );
        const simId = simResult.rows[0].id;
        const cachedResult = prev.cached_result;
        const cachedRawText = (await query('SELECT raw_text, filter_result, assigned_agent, voice_metrics FROM b2b_interactions WHERE id = $1', [prev.id])).rows[0];

        // Respond immediately — simulation runs in background
        res.status(201).json({
          success: true,
          data: {
            interaction_id: simId,
            status: 'recibido',
            audio_filename: req.file.originalname,
            area: areaCheck.rows[0].display_name,
            pipeline_mode: 'cached_simulation',
            message: 'Audio recibido, analizando...'
          }
        });

        // Simulate the full pipeline with realistic delays (runs after response is sent)
        setImmediate(async () => {
          const delay = (ms) => new Promise(r => setTimeout(r, ms));
          try {
            await query("UPDATE b2b_interactions SET status = 'transcribiendo' WHERE id = $1", [simId]);
            await delay(3000 + Math.random() * 3000); // 3-6s — feels like Whisper

            await query("UPDATE b2b_interactions SET status = 'transcrito', raw_text = $1, voice_metrics = $2 WHERE id = $3",
              [cachedRawText?.raw_text || '', cachedRawText?.voice_metrics || null, simId]);
            await delay(1500 + Math.random() * 1500); // 1.5-3s

            await query("UPDATE b2b_interactions SET status = 'filtrando' WHERE id = $1", [simId]);
            await delay(1000 + Math.random() * 1000); // 1-2s

            await query(
              "UPDATE b2b_interactions SET filter_result = $1, assigned_agent = $2, status = 'filtrado' WHERE id = $3",
              [cachedRawText?.filter_result || null, cachedRawText?.assigned_agent || null, simId]
            );
            await delay(500);

            await query("UPDATE b2b_interactions SET status = 'analizando' WHERE id = $1", [simId]);
            await delay(2000 + Math.random() * 2000); // 2-4s — feels like GPT

            // Apply cached result to new interaction
            await query(
              `UPDATE b2b_interactions
               SET agent_result = $1, status = 'en_revision', processed_at = CURRENT_TIMESTAMP
               WHERE id = $2`,
              [JSON.stringify(cachedResult), simId]
            );
          } catch (err) {
            console.error('[B2B] Cache simulation error:', err.message);
            await query("UPDATE b2b_interactions SET status = 'error_analisis' WHERE id = $1", [simId]).catch(() => {});
          }
        });

        return; // Response already sent
      }
      // If criteria changed or no cached result: fall through to full pipeline
    }

    // 1. Create interaction as 'recibido', including the hash and filename
    const interResult = await query(
      `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status, audio_hash, audio_filename)
       VALUES ($1, 'call', $2, '[pendiente transcripcion]', 'recibido', $3, $4)
       RETURNING id`,
      [area_id, `upload_${req.file.originalname}`, audio_hash, req.file.originalname]
    );
    const interactionId = interResult.rows[0].id;

    const audioFileName = req.file.originalname;
    const areaName = areaCheck.rows[0].display_name;

    // 2. Save audio buffer to temp file (so the queue can access it later)
    const tmpAudioPath = path.join(os.tmpdir(), `b2b_upload_${interactionId}_${Date.now()}${path.extname(audioFileName) || '.mp3'}`);
    fs.writeFileSync(tmpAudioPath, audioBuffer);

    // 3. Save temp path in DB so pipeline can find it
    await query(
      "UPDATE b2b_interactions SET source_id = $1 WHERE id = $2",
      [tmpAudioPath, interactionId]
    );

    // 4. Respond IMMEDIATELY — pipeline runs via queue
    res.status(201).json({
      success: true,
      data: {
        interaction_id: interactionId,
        status: 'recibido',
        assigned_agent: null,
        transcription_preview: '',
        transcription_length: 0,
        file_name: audioFileName,
        area: areaName,
        pipeline_mode: 'queued',
        filter_result: null,
        message: 'Audio recibido, en cola de procesamiento...'
      }
    });

    // 5. Enqueue transcription — processed sequentially (1 at a time)
    // quality: 'high' = use WhisperX (slower, more accurate), 'fast' = skip WhisperX (use Groq/OpenAI)
    await addJob('transcribe', { interactionId, audioUrl: tmpAudioPath, quality: quality || 'high' });

  } catch (error) {
    console.error('[B2B Client] uploadAudio error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
/**
 * DELETE /api/v1/b2b/interactions/:id
 * Delete a single interaction
 */
async function deleteInteraction(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;

    // Verify interaction belongs to client
    const check = await query(
      `SELECT i.id
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );

    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    await query('DELETE FROM b2b_interactions WHERE id = $1', [id]);

    res.json({ success: true, message: 'Interaction deleted' });

  } catch (error) {
    console.error('[B2B Client] deleteInteraction error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /api/v1/b2b/interactions
 * Delete all interactions for the client (optionally filtered by area_id)
 * Body: { area_id? }
 */
async function deleteAllInteractions(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { area_id } = req.body || {};

    let result;
    if (area_id) {
      // Verify area belongs to client
      const areaCheck = await query(
        'SELECT id FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2',
        [area_id, b2bClientId]
      );
      if (!areaCheck.rows[0]) {
        return res.status(404).json({ success: false, error: 'Area not found' });
      }
      result = await query('DELETE FROM b2b_interactions WHERE b2b_area_id = $1', [area_id]);
    } else {
      // Delete all interactions across all areas
      result = await query(
        `DELETE FROM b2b_interactions
         WHERE b2b_area_id IN (SELECT id FROM b2b_areas WHERE b2b_client_id = $1)`,
        [b2bClientId]
      );
    }

    res.json({
      success: true,
      message: `${result.rowCount} interactions deleted`
    });

  } catch (error) {
    console.error('[B2B Client] deleteAllInteractions error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /api/v1/b2b/areas/:areaId/processing-mode
 * Update the processing mode (manual or automático) for an area
 * Body: { processing_mode: 'manual' | 'automático' }
 */
async function updateProcessingMode(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { areaId } = req.params;
    const { processing_mode } = req.body;

    if (!processing_mode || !['manual', 'automático'].includes(processing_mode)) {
      return res.status(400).json({
        success: false,
        error: "processing_mode must be 'manual' or 'automático'"
      });
    }

    // Verify area belongs to client
    const areaCheck = await query(
      'SELECT id FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2',
      [areaId, b2bClientId]
    );

    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    // Update processing mode
    const result = await query(
      `UPDATE b2b_areas
       SET processing_mode = $1
       WHERE id = $2
       RETURNING id, processing_mode`,
      [processing_mode, areaId]
    );

    res.json({
      success: true,
      data: {
        area_id: result.rows[0].id,
        processing_mode: result.rows[0].processing_mode
      }
    });
  } catch (error) {
    console.error('[B2B Client] updateProcessingMode error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/interactions/:id/selective-reprocess
 * Surgical reprocess: fix only specific criteria
 */
async function selectiveReprocess(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;
    const lockedCriteriaIds = req.body.lockedCriteriaIds ?? req.body.locked_criteria;
    const correctionCriteria = req.body.correctionCriteria ?? req.body.correction_criteria;

    if (!Array.isArray(lockedCriteriaIds) || !Array.isArray(correctionCriteria)) {
      return res.status(400).json({ success: false, error: 'lockedCriteriaIds and correctionCriteria (arrays) are required' });
    }

    // Verify ownership
    const check = await query(
      `SELECT i.id FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    // Enqueue job
    const { addJob } = require('../queues/b2bQueue');
    await addJob('selective_reprocess', { interactionId: id, lockedCriteriaIds, correctionCriteria });

    res.json({ success: true, message: 'Operación iniciada (reproceso selectivo)...' });
  } catch (error) {
    console.error('[B2B Client] selectiveReprocess error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /api/v1/b2b/interactions/:id/reassign-agent
 * Manually change the assigned agent for an interaction
 */
async function reassignAgent(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id } = req.params;
    const { agentName, filterFeedback } = req.body;

    if (!agentName) {
      return res.status(400).json({ success: false, error: 'agentName is required' });
    }

    // Get current agent + area info (also serves as ownership check)
    const check = await query(
      `SELECT i.id, i.assigned_agent, i.b2b_area_id, i.audio_hash
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    const { assigned_agent: originalAgent, b2b_area_id: areaId, audio_hash: audioHash } = check.rows[0];

    await query('UPDATE b2b_interactions SET assigned_agent = $1 WHERE id = $2', [agentName, id]);

    // ─── Filter Learning: teach the filter from manual corrections ───
    if (originalAgent && originalAgent !== agentName) {
      setImmediate(async () => {
        try {
          const filterAgent = await getFilterAgent(areaId);
          if (filterAgent?.id) {
            const motivo = filterFeedback?.trim() || 'corrección manual del auditor';
            const rule = `Cuando una llamada fue clasificada como "${originalAgent}" pero en realidad corresponde a "${agentName}", reclasifica a "${agentName}". Motivo: ${motivo}.`;
            await accumulateFeedback(filterAgent.id, rule);
            console.log(`[B2B Filter Learn] Rule added: "${originalAgent}" → "${agentName}"`);
          }

          // Update evaluation history cache so re-uploads use the corrected agent
          if (audioHash) {
            await query(
              `UPDATE b2b_evaluation_history SET assigned_agent = $1, updated_at = CURRENT_TIMESTAMP
               WHERE audio_hash = $2 AND b2b_area_id = $3`,
              [agentName, audioHash, areaId]
            );
          }
        } catch (err) {
          console.error('[B2B Filter Learn] Error:', err.message);
        }
      });
    }

    res.json({ success: true, message: `Interacción reasignada a "${agentName}"` });
  } catch (error) {
    console.error('[B2B Client] reassignAgent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /api/v1/b2b/agents/:agentId/feedback
 * Clear an agent's accumulated feedback
 */
async function clearFeedback(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { agentId } = req.params;

    // Verify agent ownership
    const check = await query(
      `SELECT ag.id FROM b2b_agents ag
       JOIN b2b_areas a ON ag.b2b_area_id = a.id
       WHERE ag.id = $1 AND a.b2b_client_id = $2`,
      [agentId, b2bClientId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const { clearAgentFeedback } = require('../services/b2bPipelineService');
    await clearAgentFeedback(agentId);

    res.json({ success: true, message: 'Memoria de feedback borrada' });
  } catch (error) {
    console.error('[B2B Client] clearFeedback error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/upload-text
 * Upload a text document (PDF, TXT, EML, HTML) or paste raw text.
 * Skips transcription — goes straight to filter → analyze pipeline.
 * Body (multipart): file (optional), text (optional), area_id (required)
 */
async function uploadText(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { area_id, text: rawText } = req.body;

    if (!area_id) {
      return res.status(400).json({ success: false, error: 'area_id is required' });
    }
    if (!req.file && !rawText) {
      return res.status(400).json({ success: false, error: 'Debe subir un archivo o pegar texto' });
    }

    // Verify area belongs to client
    const areaCheck = await query(
      'SELECT id, display_name FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2 AND is_active = true',
      [area_id, b2bClientId]
    );
    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    let extractedText = '';
    let fileName = 'texto_pegado';

    if (req.file) {
      fileName = req.file.originalname;
      const ext = fileName.toLowerCase().split('.').pop();

      if (ext === 'pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } else {
        // TXT, EML, HTML, CSV, etc. — read as UTF-8
        extractedText = req.file.buffer.toString('utf-8');
      }
    } else {
      extractedText = rawText;
    }

    if (!extractedText || extractedText.trim().length < 10) {
      return res.status(400).json({ success: false, error: 'El texto extraído está vacío o es muy corto' });
    }

    // Hash for deduplication
    const textHash = crypto.createHash('md5').update(extractedText).digest('hex');

    // Create interaction — status='transcrito' (text is ready, skip transcription)
    const interResult = await query(
      `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status, audio_hash)
       VALUES ($1, 'text', $2, $3, 'transcrito', $4)
       RETURNING id`,
      [area_id, `text_upload_${fileName}`, extractedText.trim(), textHash]
    );
    const interactionId = interResult.rows[0].id;
    const areaName = areaCheck.rows[0].display_name;

    // Respond immediately
    res.status(201).json({
      success: true,
      data: {
        interaction_id: interactionId,
        status: 'transcrito',
        assigned_agent: null,
        transcription_preview: extractedText.substring(0, 200),
        transcription_length: extractedText.length,
        file_name: fileName,
        area: areaName,
        pipeline_mode: 'queued',
        filter_result: null,
        message: 'Texto recibido, en cola de procesamiento...'
      }
    });

    // Enqueue filter directly — skip transcription
    await addJob('filter', { interactionId });

  } catch (error) {
    console.error('[B2B Client] uploadText error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  login,
  listInteractions,
  getAreas,
  getInteraction,
  getReviewQueue,
  approveReview,
  rejectReview,
  createExport,
  downloadExport,
  uploadAudio,
  uploadText,
  deleteInteraction,
  deleteAllInteractions,
  updateProcessingMode,
  selectiveReprocess,
  reassignAgent,
  clearFeedback
};
