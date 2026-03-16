const { query } = require('../config/database');

// =====================================================
// JOB: Limpieza de datos expirados
// Se ejecuta cada 24 horas
// =====================================================

/**
 * Eliminar refresh tokens JWT expirados
 */
async function cleanExpiredRefreshTokens() {
  try {
    const result = await query(`
      DELETE FROM refresh_tokens
      WHERE expires_at <= CURRENT_TIMESTAMP
    `);

    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} refresh tokens expirados eliminados`);
    }
    return result.rowCount;
  } catch (error) {
    // La tabla puede no existir si usan otra estrategia de refresh tokens
    if (error.message.includes('does not exist')) {
      return 0;
    }
    console.error('Error limpiando refresh tokens:', error.message);
    return 0;
  }
}

/**
 * Eliminar códigos de verificación de email usados/expirados
 */
async function cleanExpiredVerificationCodes() {
  try {
    const result = await query(`
      DELETE FROM verification_codes
      WHERE used = true
         OR expires_at <= CURRENT_TIMESTAMP
         OR created_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
    `);

    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} códigos de verificación eliminados`);
    }
    return result.rowCount;
  } catch (error) {
    if (error.message.includes('does not exist')) {
      return 0;
    }
    console.error('Error limpiando verification codes:', error.message);
    return 0;
  }
}

/**
 * Eliminar estados OAuth temporales expirados (> 30 min)
 */
async function cleanExpiredOAuthStates() {
  try {
    const result = await query(`
      DELETE FROM system_config
      WHERE key LIKE 'oauth_state_%'
        AND updated_at <= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
    `);

    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} estados OAuth expirados eliminados`);
    }
    return result.rowCount;
  } catch (error) {
    console.error('Error limpiando OAuth states:', error.message);
    return 0;
  }
}

/**
 * Limpiar sesiones de webchat inactivas (sin mensajes en 24h)
 */
async function cleanInactiveWebchatSessions() {
  try {
    const result = await query(`
      UPDATE conversations
      SET status = 'closed', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'open'
        AND last_message_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
        AND client_service_id IN (
          SELECT cs.id FROM client_services cs
          JOIN services s ON cs.service_id = s.id
          WHERE s.code = 'webchat'
        )
    `);

    if (result.rowCount > 0) {
      console.log(`🧹 [CRON] ${result.rowCount} sesiones de webchat cerradas por inactividad`);
    }
    return result.rowCount;
  } catch (error) {
    console.error('Error cerrando sesiones webchat:', error.message);
    return 0;
  }
}

/**
 * Ejecutar todas las tareas de limpieza
 */
async function runAllCleanup() {
  console.log('🧹 [CRON] Iniciando limpieza general...');

  const results = {
    refreshTokens: await cleanExpiredRefreshTokens(),
    verificationCodes: await cleanExpiredVerificationCodes(),
    oauthStates: await cleanExpiredOAuthStates(),
    webchatSessions: await cleanInactiveWebchatSessions()
  };

  const total = Object.values(results).reduce((sum, v) => sum + v, 0);
  console.log(`🧹 [CRON] Limpieza completada: ${total} registros procesados`);

  return results;
}

module.exports = {
  cleanExpiredRefreshTokens,
  cleanExpiredVerificationCodes,
  cleanExpiredOAuthStates,
  cleanInactiveWebchatSessions,
  runAllCleanup
};
