const { query } = require('../config/database');
const { TRIAL, BASIC, PRO, PAID, SERVICE_STATUS, CONVERSATION_LIMITS } = require('../config/constants');

/**
 * Verifica si un servicio puede recibir más mensajes hoy
 * Diferencia entre Trial (100), Basic (500) y Pro (2000)
 * @param {string} clientServiceId - ID del client_service
 * @returns {Promise<{allowed: boolean, remaining: number, limit: number}>}
 */
const checkMessageLimit = async (clientServiceId) => {
  try {
    // Obtener información del servicio incluyendo plan_type
    const serviceInfo = await query(
      'SELECT status, plan_type FROM client_services WHERE id = $1',
      [clientServiceId]
    );

    if (serviceInfo.rows.length === 0) {
      return { allowed: false, remaining: 0, limit: 0, error: 'Servicio no encontrado' };
    }

    const { status, plan_type } = serviceInfo.rows[0];

    // Determinar el límite según el estado Y el plan
    let dailyLimit;
    if (status === SERVICE_STATUS.TRIAL) {
      dailyLimit = TRIAL.MAX_MESSAGES_PER_DAY; // 100
    } else if (status === SERVICE_STATUS.ACTIVE) {
      // Diferenciar entre Basic y Pro
      if (plan_type === 'basic') {
        dailyLimit = BASIC.MAX_MESSAGES_PER_DAY; // 500
      } else {
        dailyLimit = PRO.MAX_MESSAGES_PER_DAY; // 2000
      }
    } else {
      return { allowed: false, remaining: 0, limit: 0, error: 'Servicio inactivo' };
    }

    // Obtener el uso de hoy
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const usageResult = await query(
      'SELECT message_count FROM message_usage WHERE client_service_id = $1 AND date = $2',
      [clientServiceId, today]
    );

    const currentCount = usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0;
    const remaining = Math.max(0, dailyLimit - currentCount);
    const allowed = currentCount < dailyLimit;

    return {
      allowed,
      remaining,
      limit: dailyLimit,
      current: currentCount,
      status,
      plan_type: plan_type || 'pro'
    };

  } catch (error) {
    console.error('Error en checkMessageLimit:', error);
    return { allowed: false, remaining: 0, limit: 0, error: error.message };
  }
};

/**
 * Incrementa el contador de mensajes para hoy
 * @param {string} clientServiceId - ID del client_service
 * @returns {Promise<{success: boolean, count: number}>}
 */
const incrementMessageCount = async (clientServiceId) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Upsert: Incrementa si existe, crea si no existe
    const result = await query(
      `INSERT INTO message_usage (client_service_id, date, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (client_service_id, date)
       DO UPDATE SET
         message_count = message_usage.message_count + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING message_count`,
      [clientServiceId, today]
    );

    return {
      success: true,
      count: result.rows[0].message_count
    };

  } catch (error) {
    console.error('Error en incrementMessageCount:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Obtiene el uso de mensajes de un servicio para hoy
 * @param {string} clientServiceId - ID del client_service
 * @returns {Promise<{current: number, limit: number, remaining: number}>}
 */
const getMessageUsage = async (clientServiceId) => {
  const limitCheck = await checkMessageLimit(clientServiceId);
  return {
    current: limitCheck.current || 0,
    limit: limitCheck.limit,
    remaining: limitCheck.remaining,
    status: limitCheck.status
  };
};

/**
 * Obtiene el historial de uso de mensajes (últimos 30 días)
 * @param {string} clientServiceId - ID del client_service
 * @returns {Promise<Array>}
 */
const getUsageHistory = async (clientServiceId) => {
  try {
    const result = await query(
      `SELECT date, message_count
       FROM message_usage
       WHERE client_service_id = $1
         AND date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY date DESC`,
      [clientServiceId]
    );

    return result.rows;
  } catch (error) {
    console.error('Error en getUsageHistory:', error);
    return [];
  }
};

/**
 * Verifica si una conversación puede recibir más mensajes hoy (anti-abuso)
 * @param {string} conversationId - ID de la conversación
 * @returns {Promise<{allowed: boolean, remaining: number, limit: number}>}
 */
const checkConversationLimit = async (conversationId) => {
  try {
    const dailyLimit = CONVERSATION_LIMITS.MAX_MESSAGES_PER_DAY;
    const today = new Date().toISOString().split('T')[0];

    const usageResult = await query(
      'SELECT message_count FROM conversation_message_usage WHERE conversation_id = $1 AND date = $2',
      [conversationId, today]
    );

    const currentCount = usageResult.rows.length > 0 ? usageResult.rows[0].message_count : 0;
    const remaining = Math.max(0, dailyLimit - currentCount);
    const allowed = currentCount < dailyLimit;

    return {
      allowed,
      remaining,
      limit: dailyLimit,
      current: currentCount
    };

  } catch (error) {
    console.error('Error en checkConversationLimit:', error);
    return { allowed: false, remaining: 0, limit: 0, error: error.message };
  }
};

/**
 * Incrementa el contador de mensajes para una conversación hoy
 * @param {string} conversationId - ID de la conversación
 * @returns {Promise<{success: boolean, count: number}>}
 */
const incrementConversationCount = async (conversationId) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const result = await query(
      `INSERT INTO conversation_message_usage (conversation_id, date, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (conversation_id, date)
       DO UPDATE SET
         message_count = conversation_message_usage.message_count + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING message_count`,
      [conversationId, today]
    );

    return {
      success: true,
      count: result.rows[0].message_count
    };

  } catch (error) {
    console.error('Error en incrementConversationCount:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Atomic check-and-increment para límite de servicio.
 * Incrementa y verifica en una sola operación para evitar race conditions.
 * Si no está permitido, revierte el incremento.
 */
const atomicCheckAndIncrementService = async (clientServiceId) => {
  try {
    const serviceInfo = await query(
      'SELECT status, plan_type FROM client_services WHERE id = $1',
      [clientServiceId]
    );

    if (serviceInfo.rows.length === 0) {
      return { allowed: false, remaining: 0, limit: 0, error: 'Servicio no encontrado' };
    }

    const { status, plan_type } = serviceInfo.rows[0];

    let dailyLimit;
    if (status === SERVICE_STATUS.TRIAL) {
      dailyLimit = TRIAL.MAX_MESSAGES_PER_DAY;
    } else if (status === SERVICE_STATUS.ACTIVE) {
      dailyLimit = plan_type === 'basic' ? BASIC.MAX_MESSAGES_PER_DAY : PRO.MAX_MESSAGES_PER_DAY;
    } else {
      return { allowed: false, remaining: 0, limit: 0, error: 'Servicio inactivo' };
    }

    const today = new Date().toISOString().split('T')[0];

    // Verdaderamente atómico: solo incrementa si no excede el límite (sin revert)
    const result = await query(
      `INSERT INTO message_usage (client_service_id, date, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (client_service_id, date)
       DO UPDATE SET
         message_count = CASE
           WHEN message_usage.message_count < $3 THEN message_usage.message_count + 1
           ELSE message_usage.message_count
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING message_count`,
      [clientServiceId, today, dailyLimit]
    );

    const newCount = result.rows[0].message_count;
    const allowed = newCount <= dailyLimit;

    return { allowed, remaining: Math.max(0, dailyLimit - newCount), limit: dailyLimit, current: newCount, status, plan_type: plan_type || 'pro' };
  } catch (error) {
    console.error('Error en atomicCheckAndIncrementService:', error);
    return { allowed: false, remaining: 0, limit: 0, error: error.message };
  }
};

/**
 * Atomic check-and-increment para límite de conversación.
 */
const atomicCheckAndIncrementConversation = async (conversationId) => {
  try {
    const dailyLimit = CONVERSATION_LIMITS.MAX_MESSAGES_PER_DAY;
    const today = new Date().toISOString().split('T')[0];

    // Verdaderamente atómico: solo incrementa si no excede el límite
    const result = await query(
      `INSERT INTO conversation_message_usage (conversation_id, date, message_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (conversation_id, date)
       DO UPDATE SET
         message_count = CASE
           WHEN conversation_message_usage.message_count < $3 THEN conversation_message_usage.message_count + 1
           ELSE conversation_message_usage.message_count
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING message_count`,
      [conversationId, today, dailyLimit]
    );

    const newCount = result.rows[0].message_count;
    const allowed = newCount <= dailyLimit;

    return { allowed, remaining: Math.max(0, dailyLimit - newCount), limit: dailyLimit, current: newCount };
  } catch (error) {
    console.error('Error en atomicCheckAndIncrementConversation:', error);
    return { allowed: false, remaining: 0, limit: 0, error: error.message };
  }
};

module.exports = {
  checkMessageLimit,
  incrementMessageCount,
  getMessageUsage,
  getUsageHistory,
  checkConversationLimit,
  incrementConversationCount,
  atomicCheckAndIncrementService,
  atomicCheckAndIncrementConversation
};
