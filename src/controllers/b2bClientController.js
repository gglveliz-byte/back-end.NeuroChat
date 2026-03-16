const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { query } = require('../config/database');
const { generateB2BToken } = require('../middlewares/b2bAuth');
const { generateExcel } = require('../services/b2bExportService');
const { addJob, isQueueReady } = require('../queues/b2bQueue');
const { transcribeAudioFromBufferFull, diarizeTranscription } = require('../services/b2bTranscriptionService');
const { stepFilter, stepAnalyze, stepSelectiveReprocess, clearAgentFeedback } = require('../services/b2bPipelineService');

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
      `SELECT i.*, a.display_name AS area_name, a.name AS area_code,
              ag.evaluation_template,
              (i.agent_result->>'calificacion')::numeric AS calificacion,
              (i.agent_result->>'porcentaje')::numeric AS porcentaje
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       LEFT JOIN b2b_agents ag ON ag.b2b_area_id = i.b2b_area_id 
          AND ag.type = 'specialized'
          AND LOWER(ag.name) = LOWER(i.assigned_agent)
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [id, b2bClientId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    const interaction = result.rows[0];

    // Enrich criteria with dynamic columns from the Excel template
    if (interaction.agent_result && Array.isArray(interaction.agent_result.criterios) && interaction.evaluation_template) {
      if (!interaction.agent_result.template_headers) {
        const templateText = interaction.evaluation_template.trim();
        
        // Handle new JSON Array format
        if (templateText.startsWith('[')) {
          try {
            const rows = JSON.parse(templateText);
            if (rows.length > 0) {
              const headers = Object.keys(rows[0]).filter(k => k !== '_id');
              
              interaction.agent_result.criterios = interaction.agent_result.criterios.map(c => {
                // If the AI result already has template_data (from the agent service), use it.
                if (c.template_data) return c;
                
                let matchedRow;
                if (c.id != null) {
                   matchedRow = rows.find(r => r._id === Number(c.id));
                } else {
                   // Legacy name match fallback
                   matchedRow = rows.find(r => Object.values(r).some(v => typeof v === 'string' && v.trim().toLowerCase() === (c.nombre || '').toLowerCase()));
                }

                if (matchedRow) {
                  const { _id, ...cleanRow } = matchedRow;
                  return { ...c, template_data: cleanRow };
                }
                return c;
              });
              interaction.agent_result.template_headers = headers;
            }
          } catch (e) {
            console.error("[B2B Client] Error parsing JSON evaluation_template:", e);
          }
        } 
        // Handle legacy Text format
        else {
          const lines = templateText.split('\n').filter(l => l.trim() && !l.trim().startsWith('==='));
          if (lines.length >= 2) {
            const headers = lines[0].split('|').map(h => h.trim());
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
              if (lines[i].includes('---')) continue;
              const cols = lines[i].split('|').map(c => c.trim());
              const rowObj = {};
              headers.forEach((h, idx) => { rowObj[h] = cols[idx] || ''; });
              rows.push(rowObj);
            }
   
            interaction.agent_result.criterios = interaction.agent_result.criterios.map(c => {
              const matchedRow = rows.find(r => Object.values(r).some(v => typeof v === 'string' && v.trim().toLowerCase() === (c.nombre || '').toLowerCase()));
              if (matchedRow) {
                return { ...c, template_data: matchedRow };
              }
              return c;
            });
            interaction.agent_result.template_headers = headers;
          }
        }
      }
    }

    // evaluation_template is intentionally kept in the response so the frontend
    // can render the full criteria table and support the selective-reprocess panel.

    res.json({ success: true, data: interaction });

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

    // Save evaluation history snapshot (survives future deletion)
    const { saveEvaluationHistory } = require('../services/b2bPipelineService');
    setImmediate(() => saveEvaluationHistory(id));

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

    // ─── Accumulate feedback into the assigned agent (Smart Learning) ───
    const interactionData = await query(
      `SELECT i.assigned_agent, i.b2b_area_id, c.ai_provider, c.ai_api_key, c.ai_model
       FROM b2b_interactions i 
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       JOIN b2b_clients c ON a.b2b_client_id = c.id
       WHERE i.id = $1`,
      [id]
    );

    if (interactionData.rows[0]?.assigned_agent) {
      const { assigned_agent, b2b_area_id, ai_provider, ai_api_key, ai_model } = interactionData.rows[0];
      
      // Attempt to distill specific feedback into a general rule
      const { distillFeedback, distillFilterFeedback } = require('../services/b2bAgentService');
      
      const config = { ai_provider, ai_api_key, ai_model };

      // 1. Audit Rule (for the specialized agent)
      const distilledRule = await distillFeedback(feedback, config);
      if (distilledRule) {
        await query(
          `UPDATE b2b_agents
           SET feedback_accumulated = COALESCE(feedback_accumulated, '') || E'\n- ' || $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE b2b_area_id = $2 AND name = $3 AND type = 'specialized'`,
          [distilledRule, b2b_area_id, assigned_agent]
        );
        console.log(`[B2B Client] Smart Learning: Added audit rule to agent "${assigned_agent}": ${distilledRule}`);
      }

      // 2. Filter Rule (for the categorization agent)
      const filterRule = await distillFilterFeedback(feedback, config);
      if (filterRule) {
        await query(
          `UPDATE b2b_agents
           SET feedback_accumulated = COALESCE(feedback_accumulated, '') || E'\n- ' || $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE b2b_area_id = $2 AND type = 'filter'`,
          [filterRule, b2b_area_id]
        );
        console.log(`[B2B Client] Smart Learning: Added filter rule for area ${b2b_area_id}: ${filterRule}`);
      }
    }

    // Save evaluation history snapshot (with human corrections)
    const { saveEvaluationHistory } = require('../services/b2bPipelineService');
    setImmediate(() => saveEvaluationHistory(id));

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

    // Compute SHA-256 of the audio buffer for content-based deduplication
    const audioHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Check if this exact audio content was already processed
    const hashMatch = await query(
      `SELECT id, status, created_at FROM b2b_interactions
       WHERE b2b_area_id = $1 AND audio_hash = $2
       AND status NOT IN ('error_cola', 'error_transcripcion', 'error_filtro', 'error_analisis', 'error_reproceso')
       ORDER BY created_at DESC LIMIT 1`,
      [area_id, audioHash]
    );
    if (hashMatch.rows[0]) {
      // Check if the agent template was updated AFTER the last evaluation
      // If so, allow re-evaluation with the new template
      const agentUpdated = await query(
        `SELECT ag.updated_at FROM b2b_agents ag
         JOIN b2b_areas a ON a.id = $1
         WHERE ag.b2b_area_id = $1 AND ag.is_active = true
         ORDER BY ag.updated_at DESC LIMIT 1`,
        [area_id]
      );
      const agentLastUpdate = agentUpdated.rows[0]?.updated_at;
      const evalCreatedAt = hashMatch.rows[0].created_at;

      if (!agentLastUpdate || new Date(agentLastUpdate) <= new Date(evalCreatedAt)) {
        // Template hasn't changed — return existing evaluation
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
      // Template changed after last evaluation — allow re-evaluation
      console.log(`[B2B Upload] Audio hash match found but agent template updated after last eval (${agentLastUpdate} > ${evalCreatedAt}). Allowing re-evaluation.`);
    }

    // 1. Create interaction as 'recibido'
    const interResult = await query(
      `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status, audio_hash)
       VALUES ($1, 'call', $2, '[pendiente transcripcion]', 'recibido', $3)
       RETURNING id`,
      [area_id, `upload_${req.file.originalname}`, audioHash]
    );
    const interactionId = interResult.rows[0].id;

    // Save the buffer before responding (req.file.buffer won't be available after response)
    const audioBuffer = Buffer.from(req.file.buffer);
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

    // Save evaluation history BEFORE deleting (memory that survives deletion)
    const { saveEvaluationHistory } = require('../services/b2bPipelineService');
    await saveEvaluationHistory(id);

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
 * Re-evaluate only specific criteria chosen by the human reviewer.
 * Body: {
 *   locked_criteria: number[],           // IDs confirmed correct (keep as-is)
 *   correction_criteria: { id: number, feedback: string }[]  // IDs to fix + why
 * }
 */
async function selectiveReprocess(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { id: interactionId } = req.params;
    const { locked_criteria = [], correction_criteria = [] } = req.body;

    if (!Array.isArray(locked_criteria) || !Array.isArray(correction_criteria)) {
      return res.status(400).json({ success: false, error: 'locked_criteria and correction_criteria must be arrays' });
    }
    if (correction_criteria.length === 0 && locked_criteria.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one locked or correction criterion is required' });
    }
    for (const ci of correction_criteria) {
      if (ci.id == null || !ci.feedback) {
        return res.status(400).json({ success: false, error: 'Each correction_criteria item must have id and feedback' });
      }
    }

    // Verify interaction belongs to this client
    const intCheck = await query(
      `SELECT i.id, i.status FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       WHERE i.id = $1 AND a.b2b_client_id = $2`,
      [interactionId, b2bClientId]
    );
    if (!intCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Interaction not found' });
    }

    const lockedIds = locked_criteria.map(Number);
    const corrItems = correction_criteria.map(ci => ({ id: Number(ci.id), feedback: ci.feedback }));

    // Run async but respond immediately
    res.json({ success: true, data: { interaction_id: interactionId, status: 'reprocesando', message: 'Reproceso quirúrgico iniciado' } });

    setImmediate(async () => {
      try {
        await stepSelectiveReprocess(interactionId, lockedIds, corrItems);
      } catch (err) {
        console.error('[B2B Client] selectiveReprocess background error:', err);
        await query("UPDATE b2b_interactions SET status = 'error_reproceso' WHERE id = $1", [interactionId]);
      }
    });

  } catch (error) {
    console.error('[B2B Client] selectiveReprocess error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /api/v1/b2b/agents/:agentId/feedback
 * Clear all accumulated feedback/learning for an agent (admin reset).
 */
async function clearFeedback(req, res) {
  try {
    const b2bClientId = req.b2bClient.id;
    const { agentId } = req.params;

    // Verify agent belongs to a client area
    const agentCheck = await query(
      `SELECT ag.id FROM b2b_agents ag
       JOIN b2b_areas a ON ag.b2b_area_id = a.id
       WHERE ag.id = $1 AND a.b2b_client_id = $2`,
      [agentId, b2bClientId]
    );
    if (!agentCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    await clearAgentFeedback(agentId);
    res.json({ success: true, message: 'Memoria del agente limpiada correctamente' });

  } catch (error) {
    console.error('[B2B Client] clearFeedback error:', error);
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
  deleteInteraction,
  deleteAllInteractions,
  updateProcessingMode,
  selectiveReprocess,
  clearFeedback
};
