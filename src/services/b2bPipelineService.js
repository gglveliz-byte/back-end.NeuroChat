const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');
const { transcribeAudioFull, diarizeTranscription, remapWhisperXSpeakers, formatVoiceMetrics, formatWhisperXMetrics } = require('./b2bTranscriptionService');
const { filterInteraction, analyzeInteraction, reprocessInteraction, selectiveReprocessInteraction, distillFeedback } = require('./b2bAgentService');

// ─── B2B Pipeline Orchestrator ──────────────────────────────────
// Executes the quality analysis pipeline step by step:
// 1. Transcribe (WhisperX primary, Groq/OpenAI fallback) → 2. Filter → 3. Analyze → 4. Mark for review
// When WhisperX is used, diarization is INCLUDED → skip GPT diarization step.
// Each step updates the DB and can be called independently by the queue.

/**
 * Get AI config for a B2B client (decrypts API key)
 * @param {string} b2bClientId
 * @returns {Promise<{ai_provider: string, ai_api_key: string, ai_model: string}>}
 */
async function getClientAIConfig(b2bClientId) {
  const result = await query(
    'SELECT ai_provider, ai_api_key, ai_model FROM b2b_clients WHERE id = $1',
    [b2bClientId]
  );
  if (!result.rows[0]) throw new Error(`B2B client not found: ${b2bClientId}`);
  return result.rows[0]; // ai_api_key is encrypted, decrypt happens in agentService
}

/**
 * Get the filter agent's custom prompt for an area (if any)
 * @param {string} areaId
 * @returns {Promise<string|null>}
 */
async function getFilterCustomPrompt(areaId) {
  const result = await query(
    "SELECT system_prompt FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'filter' AND is_active = true LIMIT 1",
    [areaId]
  );
  return result.rows[0]?.system_prompt || null;
}

/**
 * Get all specialized agent names for an area (used to build dynamic filter categories)
 * @param {string} areaId
 * @returns {Promise<string[]>}
 */
async function getAreaAgentNames(areaId) {
  const result = await query(
    "SELECT name FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'specialized' AND is_active = true ORDER BY name",
    [areaId]
  );
  return result.rows.map(r => r.name);
}

/**
 * Get a specialized agent (full object with v2 template fields)
 * @param {string} areaId
 * @param {string} agentName
 * @returns {Promise<Object|null>} Agent with id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated
 */
async function getSpecializedAgent(areaId, agentName) {
  const result = await query(
    `SELECT id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated
     FROM b2b_agents WHERE b2b_area_id = $1 AND name = $2 AND type = 'specialized' AND is_active = true LIMIT 1`,
    [areaId, agentName]
  );
  return result.rows[0] || null;
}

/**
 * Step 1: Transcribe audio (for call interactions only)
 * Tries WhisperX first (includes diarization), falls back to Groq/OpenAI + GPT diarization
 * @param {string} interactionId
 * @param {string} audioUrl
 */
async function stepTranscribe(interactionId, audioUrl, quality = 'high') {
  console.log(`[B2B Pipeline] Transcribing interaction ${interactionId} (quality: ${quality})...`);

  // Get client AI config (needed for fallback diarization)
  const intResult = await query(
    `SELECT a.b2b_client_id FROM b2b_interactions i
     JOIN b2b_areas a ON i.b2b_area_id = a.id WHERE i.id = $1`,
    [interactionId]
  );
  const clientId = intResult.rows[0]?.b2b_client_id;
  const aiConfig = clientId ? await getClientAIConfig(clientId) : null;

  await query(
    "UPDATE b2b_interactions SET status = 'transcribiendo' WHERE id = $1",
    [interactionId]
  );

  const result = await transcribeAudioFull(audioUrl, aiConfig, interactionId, quality);
  const { rawText, metricsText, voiceMetrics, whisperxUsed } = result;

  let finalText = rawText;

  if (whisperxUsed) {
    // WhisperX diarized speakers as SPEAKER_00, SPEAKER_01 — remap to Asesor/Cliente/Sistema
    console.log(`[B2B Pipeline] WhisperX used — remapping speakers to roles...`);
    await query(
      "UPDATE b2b_interactions SET status = 'mapeando_speakers' WHERE id = $1",
      [interactionId]
    );
    finalText = await remapWhisperXSpeakers(rawText, aiConfig);

    // After remapping, translate speakerStats keys from SPEAKER_XX to actual roles
    if (voiceMetrics && voiceMetrics.speakerStats) {
      const speakerMap = _buildSpeakerMapFromRemapping(rawText, finalText);
      if (Object.keys(speakerMap).length > 0) {
        const remappedStats = {};
        for (const [spk, stats] of Object.entries(voiceMetrics.speakerStats)) {
          const role = speakerMap[spk] || spk;
          if (remappedStats[role]) {
            // Merge stats if two SPEAKER_XX mapped to same role
            remappedStats[role] = {
              speech_time: (remappedStats[role].speech_time || 0) + (stats.speech_time || 0),
              word_count: (remappedStats[role].word_count || 0) + (stats.word_count || 0),
              segments: (remappedStats[role].segments || 0) + (stats.segments || 0),
              wpm: 0 // recalculate below
            };
          } else {
            remappedStats[role] = { ...stats };
          }
        }
        // Recalculate WPM for merged entries
        for (const stats of Object.values(remappedStats)) {
          stats.wpm = stats.speech_time > 0 ? Math.round((stats.word_count / stats.speech_time) * 60) : 0;
        }
        voiceMetrics.speakerStats = remappedStats;
        voiceMetrics._speakersRemapped = true;
        console.log(`[B2B Pipeline] Speaker stats remapped:`, Object.keys(remappedStats).join(', '));
      }
    }
  } else {
    // Fallback: GPT diarization needed
    await query(
      "UPDATE b2b_interactions SET status = 'procesando_diarizacion' WHERE id = $1",
      [interactionId]
    );
    finalText = await diarizeTranscription(rawText, aiConfig, metricsText || '');
  }

  const voiceMetricsJson = voiceMetrics ? JSON.stringify(voiceMetrics) : null;
  await query(
    "UPDATE b2b_interactions SET raw_text = $1, voice_metrics = $2, status = 'transcrito' WHERE id = $3",
    [finalText, voiceMetricsJson, interactionId]
  );

  const provider = whisperxUsed ? 'WhisperX' : 'Groq/OpenAI';
  console.log(`[B2B Pipeline] Transcription complete for ${interactionId} (${provider})`);
  return finalText;
}

/**
 * Step 2: Filter/classify the interaction
 * @param {string} interactionId
 */
async function stepFilter(interactionId) {
  console.log(`[B2B Pipeline] Filtering interaction ${interactionId}...`);

  // Get interaction + area + client data
  const intResult = await query(
    `SELECT i.*, a.b2b_client_id, a.id as area_id
     FROM b2b_interactions i
     JOIN b2b_areas a ON i.b2b_area_id = a.id
     WHERE i.id = $1`,
    [interactionId]
  );
  const interaction = intResult.rows[0];
  if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);

  await query(
    "UPDATE b2b_interactions SET status = 'filtrando' WHERE id = $1",
    [interactionId]
  );

  const aiConfig = await getClientAIConfig(interaction.b2b_client_id);
  const customPrompt = await getFilterCustomPrompt(interaction.area_id);
  const agentNames = await getAreaAgentNames(interaction.area_id);

  const filterResult = await filterInteraction(interaction.raw_text, customPrompt, aiConfig, agentNames);

  await query(
    `UPDATE b2b_interactions
     SET filter_result = $1, assigned_agent = $2, status = 'filtrado'
     WHERE id = $3`,
    [JSON.stringify(filterResult), filterResult.categoria, interactionId]
  );

  console.log(`[B2B Pipeline] Filtered ${interactionId} → ${filterResult.categoria} (${filterResult.confidence})`);
  return filterResult;
}

/**
 * Step 3: Analyze with specialized agent
 * @param {string} interactionId
 */
async function stepAnalyze(interactionId) {
  console.log(`[B2B Pipeline] Analyzing interaction ${interactionId}...`);

  const intResult = await query(
    `SELECT i.*, a.b2b_client_id, a.id as area_id, a.processing_mode
     FROM b2b_interactions i
     JOIN b2b_areas a ON i.b2b_area_id = a.id
     WHERE i.id = $1`,
    [interactionId]
  );
  const interaction = intResult.rows[0];
  if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);

  await query(
    "UPDATE b2b_interactions SET status = 'analizando' WHERE id = $1",
    [interactionId]
  );

  const aiConfig = await getClientAIConfig(interaction.b2b_client_id);
  const agentName = interaction.assigned_agent || 'otro';

  // Try to find specialized agent (full object with v2 fields), fall back to any active specialized agent
  let agent = await getSpecializedAgent(interaction.area_id, agentName);
  if (!agent) {
    const fallback = await query(
      `SELECT id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated
       FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'specialized' AND is_active = true LIMIT 1`,
      [interaction.area_id]
    );
    agent = fallback.rows[0];
  }

  // Check if agent has ANY usable prompt (v2 fields OR legacy system_prompt)
  const hasPrompt = agent && (agent.system_prompt || agent.evaluation_template || agent.deliverable_template);
  if (!hasPrompt) {
    await query(
      "UPDATE b2b_interactions SET status = 'sin_agente', processed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [interactionId]
    );
    console.warn(`[B2B Pipeline] No agent found for ${agentName} in area ${interaction.area_id}`);
    return null;
  }

  // Inject full voice metrics into text for analysis (stored separately, not in raw_text)
  let analysisText = interaction.raw_text;
  if (interaction.voice_metrics) {
    const vm = typeof interaction.voice_metrics === 'string' ? JSON.parse(interaction.voice_metrics) : interaction.voice_metrics;
    // Use the correct formatter: WhisperX metrics (with remapped speakers) vs fallback metrics
    const metricsBlock = vm._speakersRemapped || vm.speakersDetected ? formatWhisperXMetrics(vm) : formatVoiceMetrics(vm);
    if (metricsBlock) {
      analysisText = interaction.raw_text + '\n\n' + metricsBlock;
    }
  }

  // Check for previous evaluation of this same audio (memory that survives deletion)
  if (interaction.audio_hash) {
    const prevEval = await getEvaluationHistory(interaction.audio_hash, interaction.b2b_area_id);
    if (prevEval && prevEval.agent_result) {
      const prevCriterios = prevEval.agent_result.criterios || [];
      const corrections = prevEval.human_corrections || [];
      const prevScore = prevEval.calificacion || prevEval.agent_result.porcentaje || 0;

      // Determine what changed: criteria names, weights, or nothing
      // 3 scenarios:
      //   A) Criteria names changed → full fresh evaluation (no history at all)
      //   B) Same criteria, only weights changed → inject human corrections but NOT old score
      //   C) Nothing changed → inject full history (corrections + old score as reference)
      let changeLevel = 'none'; // 'criteria_changed' | 'weights_changed' | 'none'
      if (agent.evaluation_template && agent.evaluation_template.trim().startsWith('[')) {
        try {
          const currentCriteria = JSON.parse(agent.evaluation_template);
          const nameKey = (c) => String(c.Criterio || c.criterio || c.nombre || c.Nombre || c.id || '').toLowerCase();
          const currentNames = new Set(currentCriteria.map(c => nameKey(c)));
          const prevNames = new Set(prevCriterios.map(c => String(c.nombre || c.Criterio || c.id || '').toLowerCase()));

          // Check 1: criterion names differ significantly
          const overlap = [...currentNames].filter(n => prevNames.has(n)).length;
          const maxSize = Math.max(currentNames.size, prevNames.size);
          if (maxSize > 0 && (overlap / maxSize) < 0.7) {
            changeLevel = 'criteria_changed';
          } else {
            // Check 2: weights changed (same criteria names)
            const weightKeys = ['Peso', 'peso', 'Valor', 'valor', 'Puntos', 'puntos', 'Calificacion', 'calificacion'];
            const getWeight = (c) => {
              for (const k of weightKeys) { if (c[k] !== undefined) return String(c[k]); }
              return '';
            };
            const currentFingerprint = currentCriteria.map(c => `${nameKey(c)}:${getWeight(c)}`).sort().join('|');
            const prevFingerprint = prevCriterios.map(c => `${String(c.nombre || c.Criterio || c.id || '').toLowerCase()}:${c.puntaje || ''}`).sort().join('|');
            if (currentFingerprint !== prevFingerprint) {
              changeLevel = 'weights_changed';
            }
          }
        } catch { /* ignore parse errors */ }
      }

      if (changeLevel === 'criteria_changed') {
        // A) Criteria are completely different — fresh evaluation, no history
        console.log(`[B2B Pipeline] Criteria changed for hash ${interaction.audio_hash.substring(0, 12)}... — fresh evaluation with new template`);

      } else if (changeLevel === 'weights_changed' && corrections.length > 0) {
        // B) Same criteria but weights changed — inject ONLY human corrections (not old score)
        // This ensures the AI respects what the human corrected (CUMPLE/NO CUMPLE)
        // but recalculates the percentage with the new weights
        const correctedNames = corrections.filter(c => c.nombre).map(c => `"${c.nombre}" → ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'}`);

        const historyContext = `\n═══ CORRECCIONES HUMANAS PREVIAS (RESPETAR) ═══
Este audio fue evaluado antes y un auditor humano corrigió los siguientes criterios.
DEBES respetar estas correcciones (el humano tiene razón):
${correctedNames.join('\n')}

IMPORTANTE: Los PESOS de los criterios han cambiado. Recalcula el porcentaje con los pesos de la plantilla actual. NO uses el porcentaje anterior.`;

        agent = { ...agent, feedback_accumulated: (agent.feedback_accumulated || '') + historyContext };
        console.log(`[B2B Pipeline] Weights changed for hash ${interaction.audio_hash.substring(0, 12)}... — injecting ${corrections.length} human corrections only (no old score)`);

      } else if (changeLevel === 'none') {
        // C) Nothing changed — inject full history as reference
        const correctedNames = corrections.filter(c => c.nombre).map(c => `"${c.nombre}" → ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'}`);
        const prevSummary = prevCriterios.map(c => `- [${c.cumple ? '✓' : '✗'}] ${c.nombre}: ${c.observacion || ''}`).join('\n');

        const historyContext = `\n═══ EVALUACIÓN PREVIA DE ESTE MISMO AUDIO (${prevScore}%) ═══
Este audio ya fue evaluado anteriormente. ${corrections.length > 0 ? 'Un auditor humano corrigió algunos criterios.' : ''}
${correctedNames.length > 0 ? `\nCORRECCIONES DEL AUDITOR HUMANO (PRIORIDAD MÁXIMA):\n${correctedNames.join('\n')}` : ''}

RESULTADOS PREVIOS:
${prevSummary}

INSTRUCCIÓN: Usa esta evaluación previa como REFERENCIA. Si el auditor humano corrigió algo, RESPETA esa corrección — el humano tiene razón. Para criterios no corregidos, puedes mantener o mejorar tu análisis con evidencia.`;

        agent = { ...agent, feedback_accumulated: (agent.feedback_accumulated || '') + historyContext };
        console.log(`[B2B Pipeline] Injected evaluation history for hash ${interaction.audio_hash.substring(0, 12)}... (prev: ${prevScore}%, ${corrections.length} corrections)`);
      }
      // else: weights_changed but no human corrections — evaluate fresh (no history to protect)
    }
  }

  // Pass full agent object — analyzeInteraction detects v2 vs legacy automatically
  let agentResult;
  try {
    agentResult = await analyzeInteraction(analysisText, agent, aiConfig);
  } catch (analyzeErr) {
    console.error(`[B2B Pipeline] Analyze failed for ${interactionId}:`, analyzeErr.message);
    await query(
      `UPDATE b2b_interactions
       SET status = 'error_analisis', agent_result = $1, processed_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify({ error: analyzeErr.message, _fallback: 'Revisar o reintentar más tarde' }), interactionId]
    );
    throw analyzeErr;
  }

  // Determine final status based on processing_mode: 'automático' → 'aprobado', otherwise → 'en_revision'
  const finalStatus = interaction.processing_mode === 'automático' ? 'aprobado' : 'en_revision';

  if (interaction.processing_mode === 'automático') {
    // Automático: mark as aprobado with auto-reviewed timestamp
    await query(
      `UPDATE b2b_interactions
       SET agent_result = $1, status = $2, processed_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [JSON.stringify(agentResult), finalStatus, interactionId]
    );
  } else {
    // Manual: keep as en_revision for human review
    await query(
      `UPDATE b2b_interactions
       SET agent_result = $1, status = $2, processed_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [JSON.stringify(agentResult), finalStatus, interactionId]
    );
  }

  // Save evaluation history snapshot
  setImmediate(() => saveEvaluationHistory(interactionId));

  const score = agentResult.porcentaje != null ? `${agentResult.porcentaje}%` : `${agentResult.calificacion}/10`;
  const modeLabel = interaction.processing_mode === 'automático' ? '[AUTOMÁTICO]' : '[MANUAL]';
  console.log(`[B2B Pipeline] Analysis complete for ${interactionId} ${modeLabel} → ${finalStatus} — score: ${score}`);
  return agentResult;
}

/**
 * Step 4: Reprocess after human rejection
 * @param {string} interactionId
 * @param {string} humanFeedback
 */
async function stepReprocess(interactionId, humanFeedback) {
  console.log(`[B2B Pipeline] Reprocessing interaction ${interactionId}...`);

  const intResult = await query(
    `SELECT i.*, a.b2b_client_id, a.id as area_id
     FROM b2b_interactions i
     JOIN b2b_areas a ON i.b2b_area_id = a.id
     WHERE i.id = $1`,
    [interactionId]
  );
  const interaction = intResult.rows[0];
  if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);

  await query(
    "UPDATE b2b_interactions SET status = 'reprocesando' WHERE id = $1",
    [interactionId]
  );

  const aiConfig = await getClientAIConfig(interaction.b2b_client_id);
  const agentName = interaction.assigned_agent || 'otro';
  const agent = await getSpecializedAgent(interaction.area_id, agentName);

  const hasPrompt = agent && (agent.system_prompt || agent.evaluation_template || agent.deliverable_template);
  if (!hasPrompt) {
    throw new Error(`No agent found for reprocess: ${agentName}`);
  }

  // Pass full agent object — reprocessInteraction detects v2 vs legacy automatically
  const agentResult = await reprocessInteraction(
    interaction.raw_text,
    agent,
    interaction.agent_result,
    humanFeedback,
    aiConfig
  );

  await query(
    `UPDATE b2b_interactions
     SET agent_result = $1, status = 'en_revision',
         reprocess_count = reprocess_count + 1, processed_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [JSON.stringify(agentResult), interactionId]
  );

  // ─── Accumulate feedback permanently into the agent (bounded to 30 rules) ───
  if (humanFeedback && agent.id) {
    await accumulateFeedback(agent.id, humanFeedback);
    console.log(`[B2B Pipeline] Feedback accumulated for agent ${agentName} (${agent.id})`);
  }

  const score = agentResult.porcentaje != null ? `${agentResult.porcentaje}%` : `${agentResult.calificacion}/10`;
  console.log(`[B2B Pipeline] Reprocess complete for ${interactionId} — score: ${score}`);
  return agentResult;
}

/**
 * Append one feedback rule to an agent's feedback_accumulated,
 * keeping the total at most MAX_FEEDBACK_RULES lines (oldest trimmed first).
 */
const MAX_FEEDBACK_RULES = 30;

async function accumulateFeedback(agentId, rule) {
  // Append the new rule
  await query(
    `UPDATE b2b_agents
     SET feedback_accumulated = COALESCE(feedback_accumulated, '') || E'\n- ' || $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [rule.trim(), agentId]
  );

  // Trim to MAX_FEEDBACK_RULES by keeping the last N lines
  await query(
    `UPDATE b2b_agents
     SET feedback_accumulated = (
       SELECT string_agg(line, E'\n')
       FROM (
         SELECT unnest(
           string_to_array(
             trim(both E'\n' from feedback_accumulated),
             E'\n'
           )
         ) AS line
         OFFSET GREATEST(
           0,
           array_length(
             string_to_array(trim(both E'\n' from feedback_accumulated), E'\n'),
             1
           ) - $1
         )
       ) sub
       WHERE line <> ''
     )
     WHERE id = $2`,
    [MAX_FEEDBACK_RULES, agentId]
  );
}

/**
 * Step 4b: Selective reprocess — only fix specific criteria flagged by human reviewer.
 * Locked criteria keep their previous values exactly; only correction criteria are re-evaluated.
 * @param {string} interactionId
 * @param {number[]} lockedCriteriaIds  - IDs confirmed correct by reviewer
 * @param {{ id: number, feedback: string }[]} correctionCriteria - IDs to fix + reason
 */
async function stepSelectiveReprocess(interactionId, lockedCriteriaIds, correctionCriteria) {
  console.log(`[B2B Pipeline] Selective reprocess for ${interactionId} — locked: [${lockedCriteriaIds}], fix: [${correctionCriteria.map(c => c.id)}]`);

  const intResult = await query(
    `SELECT i.*, a.b2b_client_id, a.id as area_id
     FROM b2b_interactions i
     JOIN b2b_areas a ON i.b2b_area_id = a.id
     WHERE i.id = $1`,
    [interactionId]
  );
  const interaction = intResult.rows[0];
  if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);

  await query(
    "UPDATE b2b_interactions SET status = 'reprocesando' WHERE id = $1",
    [interactionId]
  );

  const aiConfig = await getClientAIConfig(interaction.b2b_client_id);
  const agentName = interaction.assigned_agent || 'otro';
  const agent = await getSpecializedAgent(interaction.area_id, agentName);

  if (!agent || !(agent.system_prompt || agent.evaluation_template || agent.deliverable_template)) {
    throw new Error(`No agent found for selective reprocess: ${agentName}`);
  }

  const agentResult = await selectiveReprocessInteraction(
    interaction.raw_text,
    agent,
    interaction.agent_result,
    lockedCriteriaIds,
    correctionCriteria,
    aiConfig
  );

  await query(
    `UPDATE b2b_interactions
     SET agent_result = $1, status = 'en_revision',
         reprocess_count = reprocess_count + 1, processed_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [JSON.stringify(agentResult), interactionId]
  );

  // Accumulate distilled feedback for each correction criterion into the agent (bounded)
  if (correctionCriteria.length > 0 && agent.id) {
    for (const ci of correctionCriteria) {
      if (ci.feedback && ci.feedback.trim()) {
        const distilled = await distillFeedback(ci.feedback, aiConfig);
        if (distilled) await accumulateFeedback(agent.id, distilled);
      }
    }
    console.log(`[B2B Pipeline] Selective feedback accumulated for agent ${agentName}`);
  }

  // Save evaluation history after selective reprocess (with corrections baked in)
  setImmediate(() => saveEvaluationHistory(interactionId));

  const score = agentResult.porcentaje != null ? `${agentResult.porcentaje}%` : `${agentResult.calificacion}/10`;
  console.log(`[B2B Pipeline] Selective reprocess complete for ${interactionId} — score: ${score}`);
  return agentResult;
}

/**
 * Clear all accumulated feedback for an agent (admin action).
 */
async function clearAgentFeedback(agentId) {
  await query(
    `UPDATE b2b_agents SET feedback_accumulated = '', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [agentId]
  );
}

// ─── Evaluation History (Memory that survives deletion) ─────────

/**
 * Save/update evaluation snapshot for an audio_hash.
 * Called when an interaction reaches a "final" state (aprobado, rechazado, en_revision with corrections).
 * Uses UPSERT — only keeps the LATEST evaluation per audio_hash per area.
 */
async function saveEvaluationHistory(interactionId) {
  try {
    const result = await query(
      `SELECT i.audio_hash, i.b2b_area_id, i.assigned_agent, i.agent_result,
              i.status, i.reprocess_count, i.human_feedback
       FROM b2b_interactions i
       WHERE i.id = $1 AND i.audio_hash IS NOT NULL`,
      [interactionId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];

    // Parse agent_result if stored as string
    const agentResult = typeof row.agent_result === 'string' ? JSON.parse(row.agent_result) : row.agent_result;

    // Build human_corrections from agent_result criteria that were locked/corrected
    let humanCorrections = [];
    if (agentResult?.criterios) {
      humanCorrections = agentResult.criterios
        .filter(c => c._locked || c._corrected)
        .map(c => ({ id: c.id, nombre: c.nombre, cumple: c.cumple, observacion: c.observacion }));
    }
    if (row.human_feedback) {
      humanCorrections.push({ type: 'general_feedback', feedback: row.human_feedback });
    }

    const calificacion = agentResult?.porcentaje || 0;

    await query(
      `INSERT INTO b2b_evaluation_history
        (audio_hash, b2b_area_id, assigned_agent, agent_result, calificacion, status, human_corrections, reprocess_count, source_interaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (b2b_area_id, audio_hash) DO UPDATE SET
        assigned_agent = EXCLUDED.assigned_agent,
        agent_result = EXCLUDED.agent_result,
        calificacion = EXCLUDED.calificacion,
        status = EXCLUDED.status,
        human_corrections = EXCLUDED.human_corrections,
        reprocess_count = EXCLUDED.reprocess_count,
        source_interaction_id = EXCLUDED.source_interaction_id,
        updated_at = CURRENT_TIMESTAMP`,
      [row.audio_hash, row.b2b_area_id, row.assigned_agent, JSON.stringify(agentResult),
       calificacion, row.status,
       JSON.stringify(humanCorrections), row.reprocess_count || 0, interactionId]
    );

    console.log(`[B2B Pipeline] Evaluation history saved for hash ${row.audio_hash.substring(0, 12)}...`);
    return row.audio_hash;
  } catch (err) {
    console.error('[B2B Pipeline] saveEvaluationHistory error:', err.message);
    return null;
  }
}

/**
 * Retrieve previous evaluation for a given audio_hash + area.
 * Returns the stored agent_result and human corrections, or null if none.
 */
async function getEvaluationHistory(audioHash, areaId) {
  try {
    const result = await query(
      `SELECT agent_result, calificacion, human_corrections, assigned_agent, status, reprocess_count, updated_at
       FROM b2b_evaluation_history
       WHERE audio_hash = $1 AND b2b_area_id = $2`,
      [audioHash, areaId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[B2B Pipeline] getEvaluationHistory error:', err.message);
    return null;
  }
}

/**
 * Build a mapping from SPEAKER_XX → role by comparing raw WhisperX text with remapped text.
 * Looks at the first occurrence of each SPEAKER_XX in the raw text and finds what role
 * replaced it in the same position of the remapped text.
 */
function _buildSpeakerMapFromRemapping(rawText, remappedText) {
  const map = {};
  // Extract unique speakers from raw text
  const speakerRegex = /^(SPEAKER_\d+):/gm;
  const speakers = new Set();
  let m;
  while ((m = speakerRegex.exec(rawText)) !== null) {
    speakers.add(m[1]);
  }

  // For each speaker, find what role appears in the remapped text
  // Strategy: count occurrences of each role and correlate with speaker order
  const roles = ['[Sistema]', 'Asesor', 'Cliente'];
  const rawLines = rawText.split('\n');
  const remappedLines = remappedText.split('\n');

  // Build speaker appearance order from raw text (first line each speaker talks)
  const speakerOrder = [];
  const seen = new Set();
  for (const line of rawLines) {
    const spkMatch = line.match(/^(SPEAKER_\d+):/);
    if (spkMatch && !seen.has(spkMatch[1])) {
      seen.add(spkMatch[1]);
      speakerOrder.push(spkMatch[1]);
    }
  }

  // Build role appearance order from remapped text
  const roleOrder = [];
  const seenRoles = new Set();
  for (const line of remappedLines) {
    for (const role of roles) {
      const prefix = role === '[Sistema]' ? '[Sistema]:' : `${role}:`;
      if (line.startsWith(prefix) && !seenRoles.has(role)) {
        seenRoles.add(role);
        roleOrder.push(role);
      }
    }
  }

  // Map by appearance order (first speaker → first role, etc.)
  for (let i = 0; i < speakerOrder.length; i++) {
    if (i < roleOrder.length) {
      map[speakerOrder[i]] = roleOrder[i];
    }
  }

  return map;
}

module.exports = {
  stepTranscribe,
  stepFilter,
  stepAnalyze,
  stepReprocess,
  stepSelectiveReprocess,
  clearAgentFeedback,
  getClientAIConfig,
  saveEvaluationHistory,
  getEvaluationHistory
};
