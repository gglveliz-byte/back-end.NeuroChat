const { query, transaction } = require('../config/database');
const { decrypt } = require('../utils/encryption');
const { transcribeAudioFull, diarizeTranscription, remapWhisperXSpeakers, formatVoiceMetrics, formatWhisperXMetrics } = require('./b2bTranscriptionService');
const { filterInteraction, analyzeInteraction, reprocessInteraction, selectiveReprocessInteraction, distillFeedback, refineTemplateDescription, findDescriptionKey, findCriterionNameKey, normalizeName } = require('./b2bAgentService');
const { recordB2bTokenUsage, recordB2bTranscriptionCost } = require('./b2bTokenService');

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
async function getFilterAgent(areaId) {
  const result = await query(
    "SELECT id, system_prompt, feedback_accumulated FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'filter' AND is_active = true LIMIT 1",
    [areaId]
  );
  return result.rows[0] || null;
}

/**
 * Get all specialized agent names for an area (used to build dynamic filter categories)
 * @param {string} areaId
 * @returns {Promise<string[]>}
 */
async function getAreaAgentNames(areaId) {
  const result = await query(
    "SELECT name, description, filter_hint FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'specialized' AND is_active = true ORDER BY name",
    [areaId]
  );
  return result.rows;
}

/**
 * Get a specialized agent (full object with v2 template fields)
 * @param {string} areaId
 * @param {string} agentName
 * @returns {Promise<Object|null>} Agent with id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated
 */
async function getSpecializedAgent(areaId, agentName) {
  const result = await query(
    `SELECT id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, multi_agent_enabled, multi_agent_config
     FROM b2b_agents WHERE b2b_area_id = $1 AND name = $2 AND type = 'specialized' AND is_active = true LIMIT 1`,
    [areaId, agentName]
  );
  return result.rows[0] || null;
}

/**
 * Detect how many advisors (Asesor 1, Asesor 2, etc.) are in a remapped transcript.
 * Returns array of { index, label } objects.
 */
function detectAdvisorsInTranscript(text) {
  const advisors = [];
  // Multi-agent format: "Asesor 1:", "Asesor 2:", etc.
  const multiMatch = text.match(/Asesor (\d+):/g);
  if (multiMatch) {
    const indices = [...new Set(multiMatch.map(m => parseInt(m.match(/\d+/)[0])))].sort((a, b) => a - b);
    for (const idx of indices) {
      advisors.push({ index: idx, label: `Asesor ${idx}` });
    }
  }
  // Single advisor format: "Asesor:" (no number)
  if (advisors.length === 0 && /Asesor:/i.test(text)) {
    advisors.push({ index: 1, label: 'Asesor' });
  }
  return advisors;
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
  const { rawText, metricsText, voiceMetrics, whisperxUsed, audioUsedOpenAI, audioDurationSecs } = result;

  // If OpenAI Whisper-1 fallback was used (WhisperX + Groq both unavailable), record cost
  if (!whisperxUsed && audioUsedOpenAI && clientId) {
    setImmediate(() => recordB2bTranscriptionCost({ b2bClientId: clientId, interactionId, audioDurationSecs }));
  }

  let finalText = rawText;

  if (whisperxUsed) {
    // WhisperX diarized speakers as SPEAKER_00, SPEAKER_01 — remap to Asesor/Cliente/Sistema
    console.log(`[B2B Pipeline] WhisperX used — remapping speakers to roles...`);
    await query(
      "UPDATE b2b_interactions SET status = 'mapeando_speakers' WHERE id = $1",
      [interactionId]
    );
    // Check if any agent in the area has multi_agent_enabled
    const areaResult = await query(
      `SELECT i.b2b_area_id FROM b2b_interactions i WHERE i.id = $1`, [interactionId]
    );
    const areaId = areaResult.rows[0]?.b2b_area_id;
    let multiAgentEnabled = false;
    if (areaId) {
      const maCheck = await query(
        `SELECT 1 FROM b2b_agents WHERE b2b_area_id = $1 AND multi_agent_enabled = true LIMIT 1`,
        [areaId]
      );
      multiAgentEnabled = maCheck.rows.length > 0;
    }
    const remapResult = await remapWhisperXSpeakers(rawText, aiConfig, { multiAgentEnabled });
    finalText = remapResult.text;
    setImmediate(() => recordB2bTokenUsage({ b2bClientId: clientId, interactionId, step: 'remap', usage: remapResult._usage }));

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
    // Fallback: GPT diarization needed (WhisperX no disponible — usa OpenAI, costo mayor)
    await query(
      "UPDATE b2b_interactions SET status = 'procesando_diarizacion' WHERE id = $1",
      [interactionId]
    );
    const diarizeResult = await diarizeTranscription(rawText, aiConfig, metricsText || '');
    finalText = diarizeResult.text;
    setImmediate(() => recordB2bTokenUsage({ b2bClientId: clientId, interactionId, step: 'diarize', usage: diarizeResult._usage }));
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

  // Check if this audio was previously reassigned manually — use that agent directly
  if (interaction.audio_hash) {
    const prevHistory = await getEvaluationHistory(interaction.audio_hash, interaction.b2b_area_id);
    if (prevHistory?.assigned_agent && prevHistory.assigned_agent !== 'otro') {
      const filterResult = {
        categoria: prevHistory.assigned_agent,
        confidence: 1.0,
        razon: `Asignación manual previa del auditor (audio ya clasificado como "${prevHistory.assigned_agent}")`
      };
      await query(
        `UPDATE b2b_interactions
         SET filter_result = $1, assigned_agent = $2, status = 'filtrado'
         WHERE id = $3`,
        [JSON.stringify(filterResult), filterResult.categoria, interactionId]
      );
      console.log(`[B2B Pipeline] Filtered ${interactionId} → ${filterResult.categoria} (from evaluation history — manual assignment)`);
      return filterResult;
    }
  }

  const aiConfig = await getClientAIConfig(interaction.b2b_client_id);
  const filterAgent = await getFilterAgent(interaction.area_id);
  const customPrompt = filterAgent?.system_prompt || null;
  const filterFeedback = filterAgent?.feedback_accumulated || '';
  const agentNames = await getAreaAgentNames(interaction.area_id);

  const { _usage: filterUsage, ...filterResult } = await filterInteraction(interaction.raw_text, customPrompt, aiConfig, agentNames, filterFeedback);
  setImmediate(() => recordB2bTokenUsage({ b2bClientId: interaction.b2b_client_id, interactionId, step: 'filter', usage: filterUsage }));

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
      `SELECT id, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, multi_agent_enabled, multi_agent_config
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
  let humanCorrectionsToForce = []; // Will be applied AFTER AI evaluation
  let cachedAgentResult = null; // If set, skip AI entirely and use this result directly
  if (interaction.audio_hash) {
    const prevEval = await getEvaluationHistory(interaction.audio_hash, interaction.b2b_area_id);
    if (prevEval && prevEval.agent_result) {
      const prevCriterios = prevEval.agent_result.criterios || [];
      const corrections = (prevEval.human_corrections || []).filter(c => c.nombre && c.cumple !== undefined);
      const prevScore = prevEval.calificacion || prevEval.agent_result.porcentaje || 0;

      // Determine what changed: criteria names, weights, or nothing
      let changeLevel = 'none'; // 'criteria_changed' | 'weights_changed' | 'none'
      if (agent.evaluation_template && agent.evaluation_template.trim().startsWith('[')) {
        try {
          const currentCriteria = JSON.parse(agent.evaluation_template);

          // Extract name from template criteria (handles "Criterio Específico" format)
          const templateNameKey = (c) => {
            const specific = c['Criterio Específico'] || c['criterio específico'] || '';
            const general = c['Criterio a evaluar'] || c['criterio a evaluar'] || '';
            if (specific && specific.toLowerCase() !== 'no aplica') {
              return `${general} - ${specific}`.toLowerCase().trim();
            }
            return String(c.Criterio || c.criterio || c.nombre || c.Nombre || c.id || '').toLowerCase().trim();
          };

          // Extract name from agent_result criteria
          const resultNameKey = (c) => String(c.nombre || c.Criterio || c.id || '').toLowerCase().trim();

          const currentNames = currentCriteria
            .filter(c => (c['Tipo de Error'] || '').toLowerCase() !== 'no aplica')
            .map(c => templateNameKey(c))
            .filter(n => n);
          const prevNamesList = prevCriterios.map(c => resultNameKey(c)).filter(n => n);

          // Use substring matching: a template name matches if it's contained in a prev name or vice versa
          let matchCount = 0;
          for (const cn of currentNames) {
            for (const pn of prevNamesList) {
              if (cn === pn || cn.includes(pn) || pn.includes(cn)) {
                matchCount++;
                break;
              }
            }
          }
          const maxSize = Math.max(currentNames.length, prevNamesList.length);
          if (maxSize > 0 && (matchCount / maxSize) < 0.7) {
            changeLevel = 'criteria_changed';
          } else {
            // Check if weights changed
            const weightKeys = ['Peso', 'peso', 'Valor', 'valor', 'Puntos', 'puntos', 'Calificacion', 'calificacion'];
            const getWeight = (c) => {
              for (const k of weightKeys) { if (c[k] !== undefined) return String(c[k]); }
              return '';
            };
            const currentFingerprint = currentCriteria
              .filter(c => (c['Tipo de Error'] || '').toLowerCase() !== 'no aplica')
              .map(c => `${templateNameKey(c)}:${getWeight(c)}`).sort().join('|');
            const prevFingerprint = prevCriterios.map(c => `${resultNameKey(c)}:${c.puntaje || ''}`).sort().join('|');
            if (currentFingerprint !== prevFingerprint) {
              changeLevel = 'weights_changed';
            }
          }
        } catch { /* ignore parse errors */ }
      }

      // Check multi-agent target changed
      if (agent.multi_agent_enabled && agent.multi_agent_config && prevEval.agent_result) {
        const maConfig = typeof agent.multi_agent_config === 'string' ? JSON.parse(agent.multi_agent_config) : agent.multi_agent_config;
        const currentTarget = maConfig.target_agents || 'first';
        const prevTarget = prevEval.agent_result._target_agent || 'unknown';
        if (prevTarget !== currentTarget) {
          changeLevel = 'criteria_changed';
          console.log(`[B2B Pipeline] Multi-agent target changed from ${prevTarget} to ${currentTarget} — forcing fresh evaluation`);
        }
      }

      if (changeLevel === 'criteria_changed') {
        // A) Criteria are completely different — fresh evaluation, no history
        console.log(`[B2B Pipeline] Criteria changed for hash ${interaction.audio_hash.substring(0, 12)}... — fresh evaluation with new template`);

      } else if (corrections.length > 0 && changeLevel === 'weights_changed') {
        // B) Human corrections exist AND weights changed — re-run AI with forced corrections so new weights apply
        humanCorrectionsToForce = corrections;
        const correctedNames = corrections.map(c => `"${c.nombre}" → ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'}: ${c.observacion || ''}`);
        const historyContext = `\n═══ CORRECCIONES HUMANAS PREVIAS (OBLIGATORIAS) ═══
Este audio fue evaluado antes y un auditor humano corrigió estos criterios.
DEBES respetar estas correcciones exactamente:
${correctedNames.join('\n')}
NOTA: Los pesos cambiaron. Recalcula el porcentaje con los pesos actuales.`;
        agent = { ...agent, feedback_accumulated: (agent.feedback_accumulated || '') + historyContext };
        console.log(`[B2B Pipeline] Weights changed — will FORCE ${corrections.length} human corrections for hash ${interaction.audio_hash.substring(0, 12)}... (prev: ${prevScore}%)`);

      } else if (prevCriterios.length > 0) {
        // C) Same criteria (with or without human corrections) — skip AI entirely, reuse exact previous result
        // Human corrections are already embedded in the cached agent_result
        cachedAgentResult = prevEval.agent_result;
        console.log(`[B2B Pipeline] CACHE HIT — reusing exact previous result for hash ${interaction.audio_hash.substring(0, 12)}... (score: ${prevScore}%, corrections: ${corrections.length})`);
      }
    }
  }

  // ─── CROSS-AUDIO LEARNING: inject correction patterns from ALL audios ───
  // If a criterion has been corrected in 2+ audios, the AI has a systematic issue with it.
  // Inject this pattern so the AI adjusts its analysis for ALL audios (not just re-uploads).
  try {
    const patterns = await getCriteriaPatterns(interaction.b2b_area_id, agentName);
    if (patterns.length > 0) {
      const patternLines = patterns.map(p => {
        const total = parseInt(p.audios_corregidos);
        const cumple = parseInt(p.veces_cumple);
        const noCumple = parseInt(p.veces_no_cumple);
        const ratio = Math.max(cumple, noCumple) / total;
        // Only include strong patterns (>= 70% consistency)
        if (ratio < 0.7) return null;
        const tendency = cumple > noCumple ? 'CUMPLE' : 'NO CUMPLE';
        const strength = total >= 5 ? 'MUY FUERTE' : total >= 3 ? 'FUERTE' : 'MODERADA';
        // Pick a representative observation
        let sampleObs = '';
        if (p.observaciones && Array.isArray(p.observaciones)) {
          const obs = p.observaciones.filter(o => o && o !== 'null');
          if (obs.length > 0) sampleObs = ` Ejemplo: ${String(obs[0]).substring(0, 120)}`;
        }
        return `- "${p.criterio}" → Tendencia ${strength} a ${tendency} (corregido en ${total} audios, ${cumple} cumple / ${noCumple} no cumple).${sampleObs}`;
      }).filter(Boolean);

      if (patternLines.length > 0) {
        const learningContext = `\n═══ APRENDIZAJE DE AUDITORÍAS ANTERIORES (${patternLines.length} patrones) ═══
El auditor humano ha corregido repetidamente los siguientes criterios en audios anteriores.
Estos patrones indican ERRORES SISTEMÁTICOS en tu análisis. AJUSTA tu evaluación:
${patternLines.join('\n')}

INSTRUCCIÓN: Para los criterios con tendencia FUERTE o MUY FUERTE, sé MÁS ESTRICTO si la tendencia es NO CUMPLE, o MÁS FLEXIBLE si la tendencia es CUMPLE. El auditor humano siempre tiene razón.`;
        agent = { ...agent, feedback_accumulated: (agent.feedback_accumulated || '') + learningContext };
        console.log(`[B2B Pipeline] Injected ${patternLines.length} cross-audio learning patterns for agent ${agentName}`);
      }
    }
  } catch (patternErr) {
    console.error('[B2B Pipeline] getCriteriaPatterns non-blocking error:', patternErr.message);
  }

  // Pass full agent object — analyzeInteraction detects v2 vs legacy automatically
  // Skip AI call entirely if we have a cached result (same audio, same criteria, no human corrections)

  // Pre-detect advisors when multi_agent_enabled so the PRIMARY analysis is focused on the intended advisor
  let preDetectedAdvisors = [];
  let primaryTarget = { label: 'Asesor 1', index: 1 };
  
  if (agent.multi_agent_enabled && agent.multi_agent_config) {
    preDetectedAdvisors = detectAdvisorsInTranscript(analysisText);
    
    if (preDetectedAdvisors.length > 0) {
      primaryTarget = preDetectedAdvisors[0];
      const maConfig = typeof agent.multi_agent_config === 'string' ? JSON.parse(agent.multi_agent_config) : agent.multi_agent_config;
      
      if (maConfig.target_agents === 'second' && preDetectedAdvisors.length > 1) {
         primaryTarget = preDetectedAdvisors.find(a => a.index === 2) || primaryTarget;
      } else if (maConfig.target_agents === 'specific' && maConfig.specific_agents?.length > 0) {
         primaryTarget = preDetectedAdvisors.find(a => a.index === maConfig.specific_agents[0]) || primaryTarget;
      }
    }
  }

  let agentResult;
  if (cachedAgentResult) {
    agentResult = cachedAgentResult;
    console.log(`[B2B Pipeline] Skipped AI call — using cached result for ${interactionId}`);
  } else {
    try {
      // When multi-agent with 2+ advisors: add focus header for the Primary Target in primary analysis
      let primaryAnalysisText = analysisText;
      if (preDetectedAdvisors.length > 1) {
        const otherAdvisors = preDetectedAdvisors.filter(a => a.index !== primaryTarget.index).map(a => a.label).join(', ');
        primaryAnalysisText = `═══ INSTRUCCIÓN ESPECIAL ═══\nEVALÚA ÚNICAMENTE al ${primaryTarget.label}. Los demás participantes (${otherAdvisors}, Cliente) son solo contexto. No los califiques.\n═══════════════════════════\n\n` + analysisText;
        console.log(`[B2B Pipeline] Multi-agent: primary analysis focused on ${primaryTarget.label}`);
      }

      const analyzeResult = await analyzeInteraction(primaryAnalysisText, agent, aiConfig);
      const { _usage: analyzeUsage, ...analyzeResultClean } = analyzeResult;
      agentResult = analyzeResultClean;
      
      if (agent.multi_agent_enabled && agent.multi_agent_config) {
        const maConfig = typeof agent.multi_agent_config === 'string' ? JSON.parse(agent.multi_agent_config) : agent.multi_agent_config;
        agentResult._target_agent = maConfig.target_agents || 'first';
      }

      setImmediate(() => recordB2bTokenUsage({ b2bClientId: interaction.b2b_client_id, interactionId, step: `analyze_${primaryTarget.label.replace(' ', '_')}`, usage: analyzeUsage }));
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
  }

  // ─── FORCE human corrections (hard override — AI cannot ignore these) ───
  if (humanCorrectionsToForce.length > 0 && agentResult?.criterios) {
    let forcedCount = 0;
    const correctionMap = {};
    humanCorrectionsToForce.forEach(c => {
      // Match by nombre (case-insensitive, trimmed)
      const key = String(c.nombre || '').toLowerCase().trim();
      if (key) correctionMap[key] = c;
    });

    agentResult.criterios = agentResult.criterios.map(criterio => {
      const key = String(criterio.nombre || '').toLowerCase().trim();
      const correction = correctionMap[key];
      if (correction) {
        forcedCount++;
        return {
          ...criterio,
          cumple: correction.cumple,
          observacion: correction.observacion || criterio.observacion,
          _humanCorrected: true // flag for traceability
        };
      }
      return criterio;
    });

    if (forcedCount > 0) {
      console.log(`[B2B Pipeline] FORCED ${forcedCount} criteria from human corrections`);
    }
  }

  // ─── RECALCULATE SCORE using category-weighted formula (matches client Excel) ───
  // Skip recalculation when using cached result — preserve exact previous score
  if (!cachedAgentResult) {
    recalculateScoreByCategory(agentResult, agent.evaluation_template);
    buildEntregableFromCriterios(agentResult, agent.deliverable_template);
  } else if (!agentResult.entregable && agent.deliverable_template) {
    // Cached result without entregable — rebuild it now
    buildEntregableFromCriterios(agentResult, agent.deliverable_template);
    console.log(`[B2B Pipeline] Rebuilt entregable for cached result ${interactionId}`);
  }

  // ─── MULTI-AGENT EVALUATION ───
  let agentResults = null;
  if (agent.multi_agent_enabled && agent.multi_agent_config && !cachedAgentResult) {
    const config = typeof agent.multi_agent_config === 'string' ? JSON.parse(agent.multi_agent_config) : agent.multi_agent_config;
    // Use pre-detected advisors (already detected before primary analysis) to avoid double detection
    const advisors = preDetectedAdvisors.length > 0 ? preDetectedAdvisors : detectAdvisorsInTranscript(analysisText);

    if (advisors.length > 1) {
      console.log(`[B2B Pipeline] Multi-agent detected: ${advisors.map(a => a.label).join(', ')} — config: ${config.target_agents}`);

      // Determine which advisors to evaluate
      let targetAdvisors = [];
      switch (config.target_agents) {
        case 'first':
          targetAdvisors = advisors.filter(a => a.index === 1);
          break;
        case 'second':
          targetAdvisors = advisors.filter(a => a.index === 2);
          break;
        case 'both':
          targetAdvisors = advisors;
          break;
        case 'specific':
          targetAdvisors = advisors.filter(a => (config.specific_agents || []).includes(a.index));
          break;
        default:
          targetAdvisors = advisors;
      }

      // Fallback: si el asesor objetivo no fue detectado en la diarización, evaluar Asesor 1
      // Ejemplo: config='second' pero el audio no tiene transferencia → solo hay Asesor 1
      if (targetAdvisors.length === 0 && advisors.length > 0) {
        console.warn(`[B2B Pipeline] ⚠️  Advisor "${config.target_agents}" not found in transcript. Detected: [${advisors.map(a => a.label).join(', ')}]. Falling back to ${advisors[0].label}.`);
        targetAdvisors = [advisors[0]];
      }

      if (targetAdvisors.length > 0) {
        agentResults = [];

        // Helper: get per-advisor template from multi_agent_config.advisor_templates[N]
        const getAdvisorTemplate = (advisorIndex) => {
          const templates = config.advisor_templates || {};
          return templates[String(advisorIndex)] || null;
        };
        const useDifferentTemplates = config.use_single_template === false;

        // Evaluate all target advisors in parallel — each is independent
        const advisorPromises = targetAdvisors.map(async (advisor, i) => {
          const advisorTemplate = useDifferentTemplates ? getAdvisorTemplate(advisor.index) : null;
          const focusHeader = `═══ INSTRUCCIÓN ESPECIAL ═══\nEVALÚA ÚNICAMENTE al ${advisor.label}. Los demás participantes (${advisors.filter(a => a.index !== advisor.index).map(a => a.label).join(', ')}, Cliente) son solo contexto. No los califiques.\n═══════════════════════════\n\n`;

          // CRITICAL FIX: Reuse primary evaluation ONLY if this advisor was the primary target
          if (advisor.index === primaryTarget.index && !advisorTemplate) {
            // Primary evaluation already computed — reuse it
            return { agent_index: advisor.index, agent_label: advisor.label, result: agentResult, isPrimary: true };
          }

          try {
            const focusText = focusHeader + analysisText;
            const advisorAgent = advisorTemplate ? { ...agent, evaluation_template: advisorTemplate } : agent;
            const advisorResult = await analyzeInteraction(focusText, advisorAgent, aiConfig);
            const { _usage: addUsage, ...addResultClean } = advisorResult;
            setImmediate(() => recordB2bTokenUsage({ b2bClientId: interaction.b2b_client_id, interactionId, step: `analyze_${advisor.label.replace(' ', '_')}`, usage: addUsage }));
            recalculateScoreByCategory(addResultClean, advisorAgent.evaluation_template);
            buildEntregableFromCriterios(addResultClean, agent.deliverable_template);
            console.log(`[B2B Pipeline] Multi-agent: ${advisor.label} evaluated — ${addResultClean.porcentaje}%`);
            return { agent_index: advisor.index, agent_label: advisor.label, result: addResultClean, isPrimary: false };
          } catch (maErr) {
            console.error(`[B2B Pipeline] Multi-agent: Failed to evaluate ${advisor.label}:`, maErr.message);
            return null;
          }
        });

        const advisorResolved = await Promise.all(advisorPromises);
        agentResults = advisorResolved.filter(Boolean).map(({ isPrimary, ...r }) => r); // strip internal flag

        // If advisor 0 had a per-advisor template, update the primary agentResult
        const primaryOverride = useDifferentTemplates ? advisorResolved.find(r => r?.isPrimary) : null;
        if (primaryOverride) agentResult = primaryOverride.result;

        console.log(`[B2B Pipeline] Multi-agent evaluation complete: ${agentResults.length} advisors evaluated`);
      }
    }
  } else if (cachedAgentResult && interaction.agent_results) {
    // Restore cached agent_results if available
    agentResults = typeof interaction.agent_results === 'string' ? JSON.parse(interaction.agent_results) : interaction.agent_results;
  }

  // Determine final status based on processing_mode: 'automático' → 'aprobado', otherwise → 'en_revision'
  const finalStatus = interaction.processing_mode === 'automático' ? 'aprobado' : 'en_revision';
  const agentResultsJson = agentResults ? JSON.stringify(agentResults) : null;

  if (interaction.processing_mode === 'automático') {
    // Automático: mark as aprobado with auto-reviewed timestamp
    await query(
      `UPDATE b2b_interactions
       SET agent_result = $1, agent_results = $2, status = $3, processed_at = CURRENT_TIMESTAMP, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [JSON.stringify(agentResult), agentResultsJson, finalStatus, interactionId]
    );
  } else {
    // Manual: keep as en_revision for human review
    await query(
      `UPDATE b2b_interactions
       SET agent_result = $1, agent_results = $2, status = $3, processed_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [JSON.stringify(agentResult), agentResultsJson, finalStatus, interactionId]
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

  const { detectAffectedCriteriaByFeedback, reprocessInteraction, selectiveReprocessInteraction } = require('./b2bAgentService');

  let agentResult;
  let affectedIds = [];
  
  try {
    affectedIds = await detectAffectedCriteriaByFeedback(agent, interaction.agent_result, humanFeedback, aiConfig);
  } catch(e) {
    console.warn(`[B2B Pipeline] Failed to detect affected criteria: ${e.message}`);
  }

  if (affectedIds && affectedIds.length > 0) {
    console.log(`[B2B Pipeline] Smart Reprocess: Detected ${affectedIds.length} affected criteria for feedback — converting to selective_reprocess`);
    const correctionItems = affectedIds.map(id => ({ id, feedback: humanFeedback }));

    agentResult = await selectiveReprocessInteraction(
      interaction.raw_text,
      agent,
      interaction.agent_result,
      [], // Auto-locks all criteria NOT in correctionItems
      correctionItems,
      aiConfig
    );

    // Auto-mejora del template para criterios afectados (non-blocking)
    for (const affectedId of affectedIds) {
      setImmediate(() => {
        applyTemplateRefinement(agent.id, affectedId, humanFeedback, aiConfig)
          .catch(err => console.error(`[B2B Pipeline] Template refinement failed for criterion ${affectedId}:`, err.message));
      });
    }
  } else {
    console.log(`[B2B Pipeline] Full Reprocess: Could not isolate specific criteria, falling back to full reprocess...`);
    agentResult = await reprocessInteraction(
      interaction.raw_text,
      agent,
      interaction.agent_result,
      humanFeedback,
      aiConfig
    );
  }

  // Recalculate score using category-weighted formula
  recalculateScoreByCategory(agentResult, agent.evaluation_template);
  buildEntregableFromCriterios(agentResult, agent.deliverable_template);

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

  // Save evaluation history after reprocess (so corrections are tracked between reprocesses)
  setImmediate(() => saveEvaluationHistory(interactionId));

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

  // Recalculate score using category-weighted formula
  recalculateScoreByCategory(agentResult, agent.evaluation_template);
  buildEntregableFromCriterios(agentResult, agent.deliverable_template);

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

        // Auto-mejora del template: IA enriquece la descripción del criterio (non-blocking)
        setImmediate(() => {
          applyTemplateRefinement(agent.id, ci.id, ci.feedback, aiConfig)
            .catch(err => console.error(`[B2B Pipeline] Template refinement failed for criterion ${ci.id}:`, err.message));
        });
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

// ─── Template Auto-Refinement (AI-to-AI learning) ─────────────

const MAX_DESCRIPTION_LENGTH = 3000;
const TEMPLATE_LEARNING_MARKER = '---[Aprendizaje IA]---';

/**
 * Enrich a criterion's description in the evaluation_template based on human corrections.
 * Reads the template, calls the AI refinement agent, and APPENDS new insights.
 * NEVER removes or modifies existing text — only adds.
 * Non-blocking: designed to be called via setImmediate(), failures are logged but never propagate.
 */
async function applyTemplateRefinement(agentId, criterionId, humanFeedback, aiConfig) {
  try {
    if (!agentId || !criterionId || !humanFeedback?.trim()) return null;

    console.log(`[B2B Pipeline] Template refinement started for agent ${agentId}, criterion ${criterionId}`);

    // Step 1: Read current template
    const agentResult = await query(
      'SELECT evaluation_template FROM b2b_agents WHERE id = $1',
      [agentId]
    );
    const raw = agentResult.rows[0]?.evaluation_template;
    if (!raw || !raw.trim().startsWith('[')) {
      console.log(`[B2B Pipeline] Template refinement skipped: no JSON template for agent ${agentId}`);
      return null;
    }

    let criteria;
    try { criteria = JSON.parse(raw); } catch { return null; }

    // Step 2: Find criterion by index (_id = index + 1)
    const rawIdx = criterionId - 1;
    if (rawIdx < 0 || rawIdx >= criteria.length) {
      console.log(`[B2B Pipeline] Template refinement skipped: criterion ${criterionId} out of range (${criteria.length} total)`);
      return null;
    }
    const criterion = criteria[rawIdx];

    // Step 3: Find description field dynamically
    const keys = Object.keys(criterion);
    const descKey = findDescriptionKey(keys);
    if (!descKey) {
      console.log(`[B2B Pipeline] Template refinement skipped: no description field found in criterion ${criterionId}`);
      return null;
    }
    const currentDesc = String(criterion[descKey] || '');

    // Step 4: Extract criterion name for AI context
    const nameKey = findCriterionNameKey(keys);
    const criterionName = nameKey ? String(criterion[nameKey]) : `Criterio #${criterionId}`;

    // Step 5: Check max length guard
    if (currentDesc.length >= MAX_DESCRIPTION_LENGTH) {
      console.warn(`[B2B Pipeline] Template refinement skipped (max length ${currentDesc.length} chars) for criterion ${criterionId}`);
      return { refined: false, reason: 'max_length' };
    }

    // Step 6: Call AI refinement
    const refinement = await refineTemplateDescription(currentDesc, criterionName, humanFeedback, aiConfig);
    if (!refinement || !refinement.wasUseful || !refinement.addendum) {
      console.log(`[B2B Pipeline] Template refinement skipped (not useful) for criterion ${criterionId}`);
      return { refined: false, reason: 'not_useful' };
    }

    // Step 7: Check combined length
    if (currentDesc.length + refinement.addendum.length + 30 > MAX_DESCRIPTION_LENGTH) {
      console.warn(`[B2B Pipeline] Template refinement skipped (would exceed max length) for criterion ${criterionId}`);
      return { refined: false, reason: 'max_length' };
    }

    // Step 8: Write back with transaction + FOR UPDATE to prevent race conditions
    await transaction(async (client) => {
      const fresh = await client.query(
        'SELECT evaluation_template FROM b2b_agents WHERE id = $1 FOR UPDATE',
        [agentId]
      );
      const freshRaw = fresh.rows[0]?.evaluation_template;
      if (!freshRaw) return;

      let freshCriteria;
      try { freshCriteria = JSON.parse(freshRaw); } catch { return; }
      if (rawIdx >= freshCriteria.length) return;

      const freshCriterion = freshCriteria[rawIdx];
      const freshDescKey = findDescriptionKey(Object.keys(freshCriterion));
      if (!freshDescKey) return;

      const freshDesc = String(freshCriterion[freshDescKey] || '');

      // APPEND: add separator only the first time, then stack below it
      const hasAutoSection = freshDesc.includes(TEMPLATE_LEARNING_MARKER);
      freshCriterion[freshDescKey] = hasAutoSection
        ? freshDesc + '\n' + refinement.addendum
        : freshDesc + '\n' + TEMPLATE_LEARNING_MARKER + '\n' + refinement.addendum;

      await client.query(
        `UPDATE b2b_agents SET evaluation_template = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(freshCriteria), agentId]
      );
    });

    console.log(`[B2B Pipeline] Template refined for agent ${agentId}, criterion ${criterionId}: +${refinement.addendum.length} chars`);
    return { refined: true, addendum: refinement.addendum };

  } catch (err) {
    console.error(`[B2B Pipeline] Template refinement failed for criterion ${criterionId}:`, err.message);
    return null;
  }
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
      `SELECT i.audio_hash, i.b2b_area_id, i.assigned_agent, i.agent_result, i.agent_results,
              i.status, i.reprocess_count, i.human_feedback
       FROM b2b_interactions i
       WHERE i.id = $1 AND i.audio_hash IS NOT NULL`,
      [interactionId]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];

    // Parse agent_result if stored as string
    const agentResult = typeof row.agent_result === 'string' ? JSON.parse(row.agent_result) : row.agent_result;

    // Build human_corrections from agent_result criteria that were locked/corrected.
    // Also compare against previous history to detect criteria changed by human reproceso.
    let humanCorrections = [];
    if (agentResult?.criterios) {
      // First: pick up explicit flags (_locked or _corrected) set during surgical reprocess
      humanCorrections = agentResult.criterios
        .filter(c => c._locked || c._corrected)
        .map(c => ({ id: c.id, nombre: c.nombre, cumple: c.cumple, observacion: c.observacion }));

      // Second: if this interaction was reprocesed (reprocess_count > 0),
      // compare current criteria against the previously saved history.
      // Any criterion whose cumple value changed = human correction.
      if ((row.reprocess_count || 0) > 0 && humanCorrections.length === 0) {
        try {
          const prevHistory = await getEvaluationHistory(row.audio_hash, row.b2b_area_id);
          const prevCriterios = prevHistory?.agent_result?.criterios || [];
          if (prevCriterios.length > 0) {
            const prevMap = {};
            prevCriterios.forEach(c => { prevMap[c.id] = c; });
            agentResult.criterios.forEach(c => {
              const prev = prevMap[c.id];
              if (prev && prev.cumple !== c.cumple) {
                // This criterion changed — human corrected it
                humanCorrections.push({ id: c.id, nombre: c.nombre, cumple: c.cumple, observacion: c.observacion });
              }
            });
            // Also carry forward any corrections from previous history that weren't changed again
            if (prevHistory.human_corrections) {
              const prevCorrections = typeof prevHistory.human_corrections === 'string'
                ? JSON.parse(prevHistory.human_corrections) : prevHistory.human_corrections;
              const alreadyCapturedIds = new Set(humanCorrections.map(c => c.id));
              prevCorrections
                .filter(c => c.id != null && !alreadyCapturedIds.has(c.id))
                .forEach(c => humanCorrections.push(c));
            }
          }
        } catch (e) {
          // Non-blocking: if history compare fails, continue with what we have
        }
      }
    }
    if (row.human_feedback) {
      humanCorrections.push({ type: 'general_feedback', feedback: row.human_feedback });
    }

    const calificacion = agentResult?.porcentaje || 0;

    const agentResultsData = row.agent_results ? (typeof row.agent_results === 'string' ? row.agent_results : JSON.stringify(row.agent_results)) : null;

    await query(
      `INSERT INTO b2b_evaluation_history
        (audio_hash, b2b_area_id, assigned_agent, agent_result, agent_results, calificacion, status, human_corrections, reprocess_count, source_interaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (b2b_area_id, audio_hash) DO UPDATE SET
        assigned_agent = EXCLUDED.assigned_agent,
        agent_result = EXCLUDED.agent_result,
        agent_results = EXCLUDED.agent_results,
        calificacion = EXCLUDED.calificacion,
        status = EXCLUDED.status,
        human_corrections = EXCLUDED.human_corrections,
        reprocess_count = EXCLUDED.reprocess_count,
        source_interaction_id = EXCLUDED.source_interaction_id,
        updated_at = CURRENT_TIMESTAMP`,
      [row.audio_hash, row.b2b_area_id, row.assigned_agent, JSON.stringify(agentResult),
       agentResultsData, calificacion, row.status,
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
 * Recalculate score using the CATEGORY-WEIGHTED formula (matches client's Excel):
 *   Score = (Críticos_CUMPLE/Críticos_Total × 0.6) + (NoCríticos_CUMPLE/NoCríticos_Total × 0.4)
 *
 * This differs from simple "sum_weights_passed / sum_weights_total".
 * Critical criteria as a GROUP = 60% of score, Non-Critical = 40%.
 * @param {Object} agentResult - The AI evaluation result with criterios[]
 * @param {string|null} evaluationTemplate - JSON string of the template with "Tipo de Error" per criterion
 */
const CRITICAL_CATEGORY_WEIGHT = 0.6;
const NON_CRITICAL_CATEGORY_WEIGHT = 0.4;

function recalculateScoreByCategory(agentResult, evaluationTemplate) {
  if (!agentResult?.criterios || agentResult.criterios.length === 0) return;

  // Build tipo map from template: criterion name → 'critico' | 'no critico'
  const tipoMap = {};
  if (evaluationTemplate) {
    try {
      const tmpl = typeof evaluationTemplate === 'string' ? JSON.parse(evaluationTemplate) : evaluationTemplate;
      tmpl.forEach(tc => {
        const tipo = (tc['Tipo de Error'] || '').toLowerCase();
        if (tipo === 'no aplica') return; // skip informational fields
        // Index by "Criterio Específico" (e.g. "Saludo y presentación")
        const specific = String(tc['Criterio Específico'] || '').toLowerCase().trim();
        // Index by full combined name (e.g. "Etiqueta Telefónica - Saludo y presentación")
        const full = `${tc['Criterio a evaluar'] || ''} - ${tc['Criterio Específico'] || ''}`.toLowerCase().trim();
        if (specific && specific !== 'no aplica') tipoMap[specific] = tipo;
        if (full) tipoMap[full] = tipo;
      });
    } catch { /* ignore parse errors */ }
  }

  let criticalPass = 0, criticalTotal = 0;
  let nonCriticalPass = 0, nonCriticalTotal = 0;

  agentResult.criterios.forEach(c => {
    const nombre = String(c.nombre || '').toLowerCase().trim();

    // Try exact match first, then substring match
    let tipo = tipoMap[nombre];
    if (!tipo) {
      for (const [tName, tTipo] of Object.entries(tipoMap)) {
        if (nombre.includes(tName) || tName.includes(nombre)) {
          tipo = tTipo;
          break;
        }
      }
    }
    // Default to critical if not found (conservative)
    if (!tipo) tipo = 'crítico';

    if (tipo.includes('no cr')) {
      nonCriticalTotal++;
      if (c.cumple) nonCriticalPass++;
    } else {
      criticalTotal++;
      if (c.cumple) criticalPass++;
    }
  });

  const criticalScore = criticalTotal > 0 ? (criticalPass / criticalTotal) : 1;
  const nonCriticalScore = nonCriticalTotal > 0 ? (nonCriticalPass / nonCriticalTotal) : 1;
  const percentage = Math.round(
    (criticalScore * CRITICAL_CATEGORY_WEIGHT + nonCriticalScore * NON_CRITICAL_CATEGORY_WEIGHT) * 100
  );

  agentResult.porcentaje = percentage;
  agentResult.calificacion = Math.round(percentage / 10);
  // Update puntaje_total/puntaje_maximo to match category-weighted formula (UI displays these)
  const rawScore = criticalScore * CRITICAL_CATEGORY_WEIGHT + nonCriticalScore * NON_CRITICAL_CATEGORY_WEIGHT;
  agentResult.puntaje_total = parseFloat(rawScore.toFixed(4));
  agentResult.puntaje_maximo = 1;
  agentResult._scoreFormula = 'category_weighted';
  agentResult._scoreBreakdown = {
    critical: { passed: criticalPass, total: criticalTotal, weight: CRITICAL_CATEGORY_WEIGHT },
    nonCritical: { passed: nonCriticalPass, total: nonCriticalTotal, weight: NON_CRITICAL_CATEGORY_WEIGHT }
  };

  console.log(`[B2B Pipeline] Score recalculated: Críticos ${criticalPass}/${criticalTotal}×0.6 + NoCríticos ${nonCriticalPass}/${nonCriticalTotal}×0.4 = ${percentage}%`);
}

/**
 * Build entregable from criterios + deliverable_template for Excel export.
 * This is called after AI evaluation to ensure entregable is always populated correctly.
 */
function buildEntregableFromCriterios(agentResult, deliverableTemplate) {
  if (!agentResult?.criterios || agentResult.criterios.length === 0) return;
  if (!deliverableTemplate) {
    // No template: build simple entregable from criterios as { nombre: "SI"/"NO" }
    const entregable = {};
    agentResult.criterios.forEach(c => {
      if (c.nombre) entregable[c.nombre] = c.cumple ? 'SI' : 'NO';
    });
    agentResult.entregable = entregable;
    return;
  }

  // Parse deliverable template columns — supports JSON array or pipe-delimited text
  let columns;
  const trimmed = deliverableTemplate.trim();
  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed);
      if (Array.isArray(rows) && rows.length > 0) {
        columns = Object.keys(rows[0]).filter(k => k && k !== '_id' && k !== 'id');
      }
    } catch (e) { /* fall through to pipe-delimited parsing */ }
  }
  if (!columns) {
    const lines = deliverableTemplate.split('\n').filter(l => l.trim() && !l.trim().startsWith('===') && !l.trim().match(/^-+(\s*\|\s*-+)*$/));
    if (lines.length === 0) return;
    columns = lines[0].split('|').map(h => h.trim()).filter(Boolean);
  }
  if (!columns || columns.length === 0) return;

  const normalize = (str) => String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const normalizeAgg = (str) => normalize(str).replace(/\b(de|del|la|las|los|el|en|y|con|por|para|al|a)\b/g, '').replace(/\s+/g, ' ').trim();

  // Build entregable: map each column to a criterion
  const entregable = {};
  const matchedIds = new Set();

  for (const col of columns) {
    const normCol = normalize(col);
    if (!normCol || normCol.length < 3) continue;

    // Special columns
    if (/^(puntaje|score)$/i.test(normCol) || normCol.includes('puntaje')) {
      entregable[col] = agentResult.porcentaje != null ? `${agentResult.porcentaje}%` : '-';
      continue;
    }
    if (normCol.includes('comentario') || normCol.includes('observacion') || normCol.includes('resumen')) {
      entregable[col] = agentResult.resumen || '-';
      continue;
    }

    // Try to match to a criterion
    const available = agentResult.criterios.filter(c => !matchedIds.has(c.id));
    let criterion = null;

    // 1. Exact match
    criterion = available.find(c => normalize(c.nombre) === normCol);

    // 2. Column in criterion nombre
    if (!criterion) criterion = available.find(c => normalize(c.nombre).includes(normCol));

    // 3. Criterion nombre in column
    if (!criterion) criterion = available.find(c => {
      const nn = normalize(c.nombre);
      return nn.length >= 5 && normCol.includes(nn);
    });

    // 4. Last part after " - "
    if (!criterion) criterion = available.find(c => {
      const parts = (c.nombre || '').split(' - ');
      if (parts.length > 1) {
        const specific = normalize(parts[parts.length - 1]);
        return specific.length >= 5 && (normCol.includes(specific) || specific.includes(normCol));
      }
      return false;
    });

    // 5. Aggressive: strip filler words (de, en, la, etc.) and retry
    if (!criterion) {
      const aggCol = normalizeAgg(col);
      if (aggCol.length >= 5) {
        criterion = available.find(c => {
          const aggN = normalizeAgg(c.nombre);
          return aggN.includes(aggCol) || aggCol.includes(aggN);
        });
        if (!criterion) criterion = available.find(c => {
          const parts = (c.nombre || '').split(' - ');
          if (parts.length > 1) {
            const aggS = normalizeAgg(parts[parts.length - 1]);
            return aggS.length >= 5 && (aggCol.includes(aggS) || aggS.includes(aggCol));
          }
          return false;
        });
      }
    }

    if (criterion) {
      entregable[col] = criterion.cumple ? 'SI' : 'NO';
      if (criterion.id != null) matchedIds.add(criterion.id);
    }
    // Don't set "-" for unmatched — leave them for the export service autoFillMetadata
  }

  agentResult.entregable = entregable;
  console.log(`[B2B Pipeline] Built entregable with ${Object.keys(entregable).length} columns from ${agentResult.criterios.length} criterios`);
}

/**
 * Get correction patterns across ALL audios for a given area + agent.
 * Returns criteria that have been corrected in 2+ different audios,
 * showing the dominant pattern (mostly CUMPLE vs mostly NO CUMPLE).
 * This is "cross-audio learning" — the AI learns from systematic mistakes.
 */
async function getCriteriaPatterns(areaId, agentName) {
  try {
    const result = await query(
      `SELECT
        correction->>'nombre' as criterio,
        COUNT(DISTINCT eh.audio_hash) as audios_corregidos,
        SUM(CASE WHEN (correction->>'cumple')::boolean THEN 1 ELSE 0 END)::int as veces_cumple,
        SUM(CASE WHEN NOT (correction->>'cumple')::boolean THEN 1 ELSE 0 END)::int as veces_no_cumple,
        jsonb_agg(DISTINCT correction->'observacion') FILTER (WHERE correction->>'observacion' IS NOT NULL) as observaciones
      FROM b2b_evaluation_history eh,
        jsonb_array_elements(human_corrections) as correction
      WHERE eh.b2b_area_id = $1
        AND eh.assigned_agent = $2
        AND correction->>'nombre' IS NOT NULL
      GROUP BY correction->>'nombre'
      HAVING COUNT(DISTINCT eh.audio_hash) >= 2
      ORDER BY COUNT(DISTINCT eh.audio_hash) DESC`,
      [areaId, agentName]
    );
    return result.rows;
  } catch (err) {
    console.error('[B2B Pipeline] getCriteriaPatterns error:', err.message);
    return [];
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
  getEvaluationHistory,
  getCriteriaPatterns,
  recalculateScoreByCategory,
  accumulateFeedback,
  applyTemplateRefinement,
  getFilterAgent
};
