const { query } = require('../config/database');
const metaOAuth = require('../services/metaOAuthService');
const emailService = require('../services/emailService');

// =====================================================
// JOB: Renovar tokens de Meta que están por expirar
// Se ejecuta cada 24 horas
// Renueva tokens que expiran en < 7 días
// =====================================================

async function refreshExpiringTokens() {
  console.log('🔄 [CRON] Iniciando renovación de tokens...');

  try {
    // Buscar tokens que expiran en menos de 7 días y están activos
    const result = await query(`
      SELECT cs.id, cs.client_id, cs.config, cs.token_expires_at, cs.token_status,
             s.code as service_code, c.email as client_email, c.name as client_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      JOIN clients c ON cs.client_id = c.id
      WHERE cs.token_expires_at IS NOT NULL
        AND cs.token_expires_at <= CURRENT_TIMESTAMP + INTERVAL '7 days'
        AND cs.token_expires_at > CURRENT_TIMESTAMP
        AND cs.token_status IN ('active', 'expiring_soon')
        AND cs.status IN ('active', 'trial')
    `);

    if (result.rows.length === 0) {
      console.log('✅ [CRON] No hay tokens por renovar');
      return { renewed: 0, failed: 0 };
    }

    console.log(`📋 [CRON] Encontrados ${result.rows.length} tokens por renovar`);

    let renewed = 0;
    let failed = 0;

    for (const service of result.rows) {
      try {
        const config = service.config || {};
        const creds = config.platform_credentials || {};

        // Determinar qué token renovar
        let currentToken = creds.user_access_token;

        // Page tokens no expiran, solo user tokens necesitan refresh
        if (!currentToken) {
          console.log(`⏭️  [CRON] ${service.service_code} (${service.client_email}) - Sin user token, posiblemente Page token (no expira)`);
          // Actualizar status a active ya que page tokens no expiran
          await query(`
            UPDATE client_services
            SET token_status = 'active', token_expires_at = NULL
            WHERE id = $1
          `, [service.id]);
          continue;
        }

        // Intentar renovar
        console.log(`🔄 [CRON] Renovando token de ${service.service_code} para ${service.client_email}...`);
        const refreshResult = await metaOAuth.refreshLongLivedToken(currentToken);

        if (refreshResult && refreshResult.accessToken) {
          // Actualizar token en config
          creds.user_access_token = refreshResult.accessToken;

          // Si es WhatsApp, el access_token también se usa directamente
          if (service.service_code === 'whatsapp') {
            creds.whatsapp_access_token = refreshResult.accessToken;
          }

          config.platform_credentials = creds;
          config.last_token_refresh = new Date().toISOString();

          const newExpiresAt = new Date();
          newExpiresAt.setSeconds(newExpiresAt.getSeconds() + (refreshResult.expiresIn || 5184000));

          await query(`
            UPDATE client_services
            SET config = $1::jsonb,
                token_expires_at = $2,
                token_refreshed_at = CURRENT_TIMESTAMP,
                token_status = 'active',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
          `, [JSON.stringify(config), newExpiresAt, service.id]);

          renewed++;
          console.log(`✅ [CRON] Token renovado: ${service.service_code} (${service.client_email}) - Expira: ${newExpiresAt.toISOString()}`);

        } else {
          // Fallo al renovar
          failed++;
          await query(`
            UPDATE client_services
            SET token_status = 'refresh_failed',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [service.id]);

          console.error(`❌ [CRON] Fallo al renovar: ${service.service_code} (${service.client_email})`);

          // Enviar email al cliente notificando que debe reconectar
          try {
            await emailService.sendTokenExpirationWarning(service.client_email, service.service_code);
          } catch (mailErr) {
            console.error(`❌ [CRON] Error enviando email de advertencia a ${service.client_email}:`, mailErr.message);
          }
        }

      } catch (tokenError) {
        failed++;
        console.error(`❌ [CRON] Error procesando token de ${service.id}:`, tokenError.message);

        // Marcar como fallido
        await query(`
          UPDATE client_services
          SET token_status = CASE
            WHEN token_expires_at <= CURRENT_TIMESTAMP THEN 'expired'
            ELSE 'refresh_failed'
          END,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [service.id]).catch(() => { });
      }
    }

    console.log(`📊 [CRON] Resultado: ${renewed} renovados, ${failed} fallidos`);
    return { renewed, failed };

  } catch (error) {
    console.error('❌ [CRON] Error general en refreshExpiringTokens:', error);
    return { renewed: 0, failed: 0, error: error.message };
  }
}

/**
 * Marcar tokens expirados (los que ya pasaron su fecha)
 */
async function markExpiredTokens() {
  try {
    const result = await query(`
      UPDATE client_services
      SET token_status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE token_expires_at IS NOT NULL
        AND token_expires_at <= CURRENT_TIMESTAMP
        AND token_status NOT IN ('expired', 'disconnected')
      RETURNING id, client_id
    `);

    if (result.rowCount > 0) {
      console.log(`⚠️  [CRON] ${result.rowCount} tokens marcados como expirados`);
    }

    return result.rowCount;
  } catch (error) {
    console.error('Error marcando tokens expirados:', error);
    return 0;
  }
}

module.exports = {
  refreshExpiringTokens,
  markExpiredTokens
};
