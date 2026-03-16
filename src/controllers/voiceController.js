/**
 * voiceController.js
 * Endpoints que VoxEngine llama durante el ciclo de vida de cada llamada.
 *
 * Flujo de una llamada:
 *  POST /call-start     → VoxEngine inicia, pedimos config del cliente
 *  POST /process-audio  → VoxEngine envía audio del usuario, respondemos con audio de IA
 *  POST /call-end       → VoxEngine cierra la llamada, registramos métricas
 *  POST /timeout-transfer → VoxEngine alcanzó el tiempo máximo, pedimos número de transferencia
 *
 * Seguridad: X-Voximplant-Secret header verificado en todas las rutas.
 */

const { query } = require('../config/database');
const { processVoiceTurn, generateWelcomeAudio, cleanupCallAudio, calculateVoiceCost } = require('../services/voiceService');
const { searchRelevantChunks } = require('../services/embeddingService');
const { checkBalance, deductCredits } = require('../services/billingService');

// In-memory store de sesiones activas (callId → estado de la llamada)
// NOTA: Se pierde en restart. Aceptable para instancia única (Render).
// Para múltiples instancias, migrar a Redis.
const activeCalls = new Map();

// Cleanup automático de sesiones huérfanas (> 30 min sin actividad)
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutos
  for (const [callId, session] of activeCalls.entries()) {
    if (now - session.startedAt > maxAge) {
      console.warn(`[Voice] Limpiando sesión huérfana: ${callId}`);
      activeCalls.delete(callId);
    }
  }
}, 5 * 60 * 1000); // Cada 5 minutos

// =====================================================
// VERIFICACIÓN DE SEGURIDAD
// =====================================================

function verifyWebhookSecret(req, res) {
  const secret = process.env.VOXIMPLANT_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('VOXIMPLANT_WEBHOOK_SECRET no configurado en producción — rechazando');
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    console.warn('VOXIMPLANT_WEBHOOK_SECRET no configurado — verificación omitida (solo desarrollo)');
    return true;
  }

  const header = req.headers['x-voximplant-secret'];
  if (header !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// =====================================================
// HELPERS
// =====================================================

/**
 * Busca el client_service por número de WhatsApp llamado.
 * El número viene en formato E.164 (ej: +593999123456).
 * Lo comparamos con voice_config.whatsapp_phone en el config JSONB.
 */
async function findClientServiceByPhone(calledPhone) {
  // Normalizar número (quitar + y espacios)
  const normalizedPhone = calledPhone.replace(/[\s+\-()]/g, '');

  const result = await query(`
    SELECT
      cs.id               AS client_service_id,
      cs.client_id,
      cs.status,
      cs.plan_type,
      cs.config,
      cs.credit_balance,
      bc.config           AS bot_config
    FROM client_services cs
    LEFT JOIN bot_configs bc ON bc.client_service_id = cs.id
    WHERE cs.status IN ('active', 'trial')
      AND (
        REPLACE(REPLACE(REPLACE(cs.config->'voice_config'->>'whatsapp_phone', '+', ''), '-', ''), ' ', '') = $1
        OR cs.config->'voice_config'->>'whatsapp_phone' = $2
      )
    LIMIT 1
  `, [normalizedPhone, calledPhone]);

  return result.rows[0] || null;
}

// =====================================================
// POST /api/v1/voice/call-start
// VoxEngine llama aquí cuando entra una nueva llamada.
// =====================================================

const callStart = async (req, res) => {
  if (!verifyWebhookSecret(req, res)) return;

  const { callId, callerPhone, calledPhone, clientServiceId } = req.body;

  console.log(`📞 [Voice] Nueva llamada: ${callerPhone} → ${calledPhone} (ID: ${callId})`);

  try {
    // Buscar client_service por número de WhatsApp
    let service;
    if (clientServiceId) {
      // Si Voximplant nos pasó el ID directamente (configurado en customData de la regla)
      const result = await query(`
        SELECT cs.id AS client_service_id, cs.client_id, cs.status, cs.plan_type,
               cs.config, cs.credit_balance, bc.config AS bot_config
        FROM client_services cs
        LEFT JOIN bot_configs bc ON bc.client_service_id = cs.id
        WHERE cs.id = $1 AND cs.status IN ('active', 'trial')
        LIMIT 1
      `, [clientServiceId]);
      service = result.rows[0];
    } else {
      service = await findClientServiceByPhone(calledPhone);
    }

    if (!service) {
      console.warn(`[Voice] No se encontró cliente para número: ${calledPhone}`);
      return res.json({
        blocked: true,
        message: 'Gracias por llamar. Este número no tiene un asistente virtual configurado.',
      });
    }

    const config = service.config || {};
    const voiceConfig = config.voice_config || {};
    const botConfig = service.bot_config || {};

    // Verificar que el servicio de voz está activo
    if (!voiceConfig.enabled) {
      return res.json({
        blocked: true,
        message: 'Gracias por llamar. El asistente de voz no está disponible en este momento.',
      });
    }

    // Verificar horario de atención
    if (voiceConfig.business_hours_enabled && !isWithinVoiceHours(voiceConfig)) {
      const outOfHoursMsg = voiceConfig.out_of_hours_message ||
        'Gracias por llamar. Nuestro horario de atención ya terminó. Te contactaremos pronto.';
      return res.json({ blocked: true, message: outOfHoursMsg });
    }

    // Verificar saldo PAYG
    if (service.plan_type === 'payg') {
      const balance = parseFloat(service.credit_balance || 0);
      if (balance <= 0) {
        console.log(`[Voice] PAYG saldo 0 para servicio ${service.client_service_id}`);
        return res.json({
          blocked: true,
          message: 'Gracias por llamar. El servicio no está disponible en este momento.',
        });
      }
    }

    // Generar audio de bienvenida
    const { audioUrl, text } = await generateWelcomeAudio(botConfig, voiceConfig, callId);

    // Crear registro en voice_calls
    await query(`
      INSERT INTO voice_calls (voximplant_call_id, client_service_id, caller_phone, called_phone, status)
      VALUES ($1, $2, $3, $4, 'active')
    `, [callId, service.client_service_id, callerPhone, calledPhone]);

    // Guardar estado en memoria
    activeCalls.set(callId, {
      clientServiceId: service.client_service_id,
      clientId: service.client_id,
      planType: service.plan_type,
      botConfig,
      voiceConfig,
      callHistory: [],
      exchangeCount: 0,
      startedAt: Date.now(),
      language: voiceConfig.language || 'es',
    });

    console.log(`✅ [Voice] Llamada iniciada para cliente ${service.client_service_id}`);

    return res.json({
      blocked: false,
      welcomeAudioUrl: audioUrl,
      welcomeText: text,
      maxDurationSeconds: voiceConfig.max_duration_seconds || 600,
    });

  } catch (err) {
    console.error('[Voice callStart] Error:', err);
    return res.json({
      blocked: true,
      message: 'Lo sentimos, hay un problema técnico. Por favor intente más tarde.',
    });
  }
};

// =====================================================
// POST /api/v1/voice/process-audio
// VoxEngine envía la URL del audio grabado del usuario.
// Devolvemos la URL del audio de respuesta de la IA.
// =====================================================

const processAudio = async (req, res) => {
  if (!verifyWebhookSecret(req, res)) return;

  const { callId, audioUrl, exchangeCount: rawExchange } = req.body;

  if (!callId || !audioUrl) {
    return res.status(400).json({ action: 'retry', message: '¿Podrías repetirlo?' });
  }

  const session = activeCalls.get(callId);
  if (!session) {
    return res.json({ action: 'hangup', message: 'La sesión ha expirado. Hasta luego.' });
  }

  session.exchangeCount = (rawExchange || session.exchangeCount) + 1;

  // Verificar saldo PAYG cada 5 intercambios para no gastar sin fondos
  if (session.planType === 'payg' && session.exchangeCount % 5 === 0) {
    try {
      const balanceCheck = await checkBalance(session.clientServiceId);
      if (!balanceCheck.hasBalance) {
        return res.json({
          action: 'hangup',
          message: 'Tu saldo se ha agotado. La llamada finalizará. Recarga tu saldo para continuar usando el servicio.',
        });
      }
    } catch (err) {
      console.error('[Voice processAudio] Error verificando saldo PAYG:', err.message);
    }
  }

  try {
    // Buscar chunks relevantes en la knowledge base (RAG)
    let knowledgeChunks = [];
    if (session.clientId) {
      try {
        // Nota: la query de Whisper llega después, aquí no tenemos el texto del usuario aún
        // Usaremos chunks más adelante cuando tengamos el texto transcrito
        // Por ahora, pasar array vacío y dejamos que processVoiceTurn lo maneje
      } catch (err) {
        console.error('[Voice processAudio] Error buscando chunks en RAG:', err.message);
      }
    }

    // Procesar el turno completo (STT → LLM → TTS)
    const result = await processVoiceTurn({
      audioUrl,
      callId,
      botConfig: session.botConfig,
      callHistory: session.callHistory,
      knowledgeChunks,
      exchangeCount: session.exchangeCount,
      voiceConfig: session.voiceConfig,
      language: session.language,
    });

    // Si tenemos texto del usuario, buscar chunks relevantes para el siguiente turno
    if (result.userText && session.clientId) {
      setImmediate(async () => {
        try {
          const chunks = await searchRelevantChunks(result.userText, session.clientId, 3);
          // Guardar para siguiente turno (no aplica al actual, ya respondimos)
          session.lastKnowledgeChunks = chunks;
        } catch (err) {
          console.error('[Voice processAudio] Error pre-cargando chunks para próximo turno:', err.message);
        }
      });
    }

    // Actualizar historial de la llamada
    if (result.userText) {
      session.callHistory.push({ role: 'user', content: result.userText });
    }
    if (result.text) {
      session.callHistory.push({ role: 'assistant', content: result.text });
    }

    // Registrar en transcript de la BD (async, no bloquear respuesta)
    if (result.userText || result.text) {
      setImmediate(async () => {
        try {
          const transcriptEntry = [];
          if (result.userText) transcriptEntry.push({ role: 'user', text: result.userText, timestamp: new Date().toISOString() });
          if (result.text) transcriptEntry.push({ role: 'bot', text: result.text, timestamp: new Date().toISOString() });

          await query(`
            UPDATE voice_calls
            SET transcript = transcript || $1::jsonb,
                total_exchanges = $2
            WHERE voximplant_call_id = $3
          `, [JSON.stringify(transcriptEntry), session.exchangeCount, callId]);
        } catch (err) {
          console.error('[Voice processAudio] Error actualizando BD con transcript:', err.message);
        }
      });
    }

    console.log(`💬 [Voice] Intercambio #${session.exchangeCount} → acción: ${result.action}`);

    return res.json({
      action: result.action,
      audioUrl: result.audioUrl,
      text: result.text,
      message: result.message,
      transferPhone: result.transferPhone,
      backupPhone: result.backupPhone,
    });

  } catch (err) {
    console.error('[Voice processAudio] Error:', err);
    return res.json({
      action: 'retry',
      text: 'Disculpa, tuve un problema técnico. ¿Puedes repetir tu consulta?',
    });
  }
};

// =====================================================
// POST /api/v1/voice/call-end
// VoxEngine llama aquí cuando la llamada termina.
// =====================================================

const callEnd = async (req, res) => {
  if (!verifyWebhookSecret(req, res)) return;

  const { callId, duration = 0, reason = 'disconnected' } = req.body;

  console.log(`📵 [Voice] Llamada terminada: ${callId} (${duration}s, razón: ${reason})`);

  const session = activeCalls.get(callId);

  try {
    // Calcular costo
    const exchangeCount = session?.exchangeCount || 0;
    const costs = calculateVoiceCost(duration, exchangeCount);

    // Determinar status final
    let status = 'resolved';
    if (reason === 'transferred') status = 'transferred';
    else if (reason === 'user_hangup' && duration < 10) status = 'abandoned';
    else if (reason === 'timeout') status = 'transferred';

    // Actualizar voice_calls
    await query(`
      UPDATE voice_calls
      SET status = $1,
          duration_seconds = $2,
          cost_usd = $3,
          billed_usd = $4,
          ended_at = NOW()
      WHERE voximplant_call_id = $5
    `, [status, duration, costs.cost_usd, costs.billed_usd, callId]);

    // Cobrar al cliente PAYG (síncrono para no perder cobros)
    if (session?.planType === 'payg' && costs.billed_usd > 0) {
      try {
        await query(`
          UPDATE client_services
          SET credit_balance = credit_balance - $1
          WHERE id = $2 AND credit_balance >= $1
        `, [costs.billed_usd, session.clientServiceId]);
      } catch (billingErr) {
        console.error('[Voice] Error cobrando PAYG:', billingErr.message);
      }
    }

    // Limpiar sesión de memoria
    activeCalls.delete(callId);

    // Limpiar archivos de audio (con delay de 2 min para que Voximplant descargue todo)
    cleanupCallAudio(callId, 120000);

    return res.json({ success: true });

  } catch (err) {
    console.error('[Voice callEnd] Error:', err);
    activeCalls.delete(callId);
    return res.json({ success: false });
  }
};

// =====================================================
// POST /api/v1/voice/timeout-transfer
// VoxEngine alcanzó el tiempo máximo de la llamada.
// =====================================================

const timeoutTransfer = async (req, res) => {
  if (!verifyWebhookSecret(req, res)) return;

  const { callId } = req.body;
  const session = activeCalls.get(callId);

  if (!session) {
    return res.json({
      message: 'El tiempo máximo de atención ha llegado. Hasta luego.',
      transferPhone: null,
    });
  }

  const voiceConfig = session.voiceConfig || {};
  const transferPhone = voiceConfig.transfer_phone || null;
  const backupPhone = voiceConfig.transfer_phone_backup || null;

  const message = voiceConfig.timeout_message ||
    'Para brindarte una mejor atención, te conectaré con uno de nuestros asesores.';

  // Marcar como transferida en la BD
  await query(`
    UPDATE voice_calls
    SET transfer_reason = 'timeout'
    WHERE voximplant_call_id = $1
  `, [callId]).catch(() => { });

  return res.json({ message, transferPhone, backupPhone });
};

// =====================================================
// GET /api/v1/voice/calls/:clientServiceId
// Lista de llamadas de un servicio (para el dashboard)
// =====================================================

const getCallHistory = async (req, res) => {
  const { clientServiceId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await query(`
      SELECT
        id, voximplant_call_id, caller_phone, called_phone,
        duration_seconds, total_exchanges, status, transfer_reason,
        cost_usd, billed_usd, created_at, ended_at,
        transcript
      FROM voice_calls
      WHERE client_service_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [clientServiceId, parseInt(limit), offset]);

    const countResult = await query(
      'SELECT COUNT(*) FROM voice_calls WHERE client_service_id = $1',
      [clientServiceId]
    );

    return res.json({
      success: true,
      data: {
        calls: result.rows,
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      },
    });
  } catch (err) {
    console.error('[Voice getCallHistory] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al obtener historial de llamadas' });
  }
};

// =====================================================
// GET /api/v1/voice/stats/:clientServiceId
// Estadísticas de voz del servicio
// =====================================================

const getVoiceStats = async (req, res) => {
  const { clientServiceId } = req.params;

  try {
    const result = await query(`
      SELECT
        COUNT(*)                                          AS total_calls,
        COUNT(*) FILTER (WHERE status = 'resolved')      AS resolved_calls,
        COUNT(*) FILTER (WHERE status = 'transferred')   AS transferred_calls,
        COUNT(*) FILTER (WHERE status = 'abandoned')     AS abandoned_calls,
        ROUND(AVG(duration_seconds))                     AS avg_duration_seconds,
        SUM(billed_usd)                                  AS total_billed_usd,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS calls_this_month
      FROM voice_calls
      WHERE client_service_id = $1
    `, [clientServiceId]);

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[Voice getVoiceStats] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al obtener estadísticas' });
  }
};

// =====================================================
// HELPERS INTERNOS
// =====================================================

function isWithinVoiceHours(voiceConfig) {
  if (!voiceConfig?.business_hours_enabled) return true;

  const schedule = voiceConfig.business_hours_schedule;
  if (!schedule) return true;

  const now = new Date();
  const timezone = voiceConfig.business_hours_timezone || 'America/Bogota';

  let localTime;
  try {
    localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  } catch {
    localTime = now;
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDay = dayNames[localTime.getDay()];
  const daySchedule = schedule[currentDay];

  if (!daySchedule?.enabled) return false;

  const currentMinutes = localTime.getHours() * 60 + localTime.getMinutes();
  const [openH, openM] = (daySchedule.open || '09:00').split(':').map(Number);
  const [closeH, closeM] = (daySchedule.close || '18:00').split(':').map(Number);

  return currentMinutes >= (openH * 60 + openM) && currentMinutes <= (closeH * 60 + closeM);
}

module.exports = {
  callStart,
  processAudio,
  callEnd,
  timeoutTransfer,
  getCallHistory,
  getVoiceStats,
};
