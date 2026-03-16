const { query } = require('../config/database');
const {
  sendTrialExpiringEmail,
  sendSubscriptionExpiringEmail,
  sendSubscriptionExpiredEmail
} = require('../services/emailService');

// =====================================================
// JOB: Expiración automática de trials y suscripciones
// =====================================================

/**
 * Expirar trials que pasaron su fecha límite
 * Se ejecuta cada hora
 */
async function expireTrials() {
  console.log('⏰ [CRON] Verificando trials expirados...');

  try {
    // Marcar trials expirados
    const result = await query(`
      UPDATE client_services
      SET status = 'expired',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= CURRENT_TIMESTAMP
      RETURNING id, client_id
    `);

    if (result.rowCount > 0) {
      console.log(`⏰ [CRON] ${result.rowCount} trials expirados`);

      for (const row of result.rows) {
        console.log(`   → Trial expirado: client_service=${row.id}, client=${row.client_id}`);
      }
    } else {
      console.log('✅ [CRON] No hay trials expirados');
    }

    return result.rowCount;
  } catch (error) {
    console.error('❌ [CRON] Error expirando trials:', error);
    return 0;
  }
}

/**
 * Notificar trials que están por expirar (faltan < 2 días)
 */
async function notifyExpiringTrials() {
  try {
    const result = await query(`
      SELECT cs.id, cs.client_id, cs.trial_ends_at,
             c.email, c.name as client_name,
             s.name as service_name
      FROM client_services cs
      JOIN clients c ON cs.client_id = c.id
      JOIN services s ON cs.service_id = s.id
      WHERE cs.status = 'trial'
        AND cs.trial_ends_at <= CURRENT_TIMESTAMP + INTERVAL '2 days'
        AND cs.trial_ends_at > CURRENT_TIMESTAMP
    `);

    if (result.rows.length > 0) {
      console.log(`📧 [CRON] ${result.rows.length} trials por expirar (< 2 días)`);
      for (const trial of result.rows) {
        const hoursLeft = Math.round(
          (new Date(trial.trial_ends_at) - new Date()) / (1000 * 60 * 60)
        );
        const daysLeft = Math.max(1, Math.ceil(hoursLeft / 24));
        console.log(`   → ${trial.client_name} (${trial.email}): ${trial.service_name} - ${hoursLeft}h restantes`);

        await sendTrialExpiringEmail(
          trial.email,
          trial.client_name,
          daysLeft,
          trial.service_name
        );
      }
    }

    return result.rows.length;
  } catch (error) {
    console.error('❌ [CRON] Error notificando trials:', error);
    return 0;
  }
}

/**
 * Notificar suscripciones que están por vencer (faltan <= 3 días)
 */
async function notifyExpiringSubscriptions() {
  console.log('📧 [CRON] Verificando suscripciones por vencer...');

  try {
    const result = await query(`
      SELECT cs.id, cs.client_id, cs.subscription_ends_at,
             c.email, c.name as client_name,
             s.name as service_name, s.price_monthly
      FROM client_services cs
      JOIN clients c ON cs.client_id = c.id
      JOIN services s ON cs.service_id = s.id
      WHERE cs.status = 'active'
        AND cs.subscription_ends_at IS NOT NULL
        AND cs.subscription_ends_at <= CURRENT_TIMESTAMP + INTERVAL '3 days'
        AND cs.subscription_ends_at > CURRENT_TIMESTAMP
    `);

    if (result.rows.length > 0) {
      console.log(`📧 [CRON] ${result.rows.length} suscripciones por vencer (< 3 días)`);
      for (const sub of result.rows) {
        const hoursLeft = Math.round(
          (new Date(sub.subscription_ends_at) - new Date()) / (1000 * 60 * 60)
        );
        const daysLeft = Math.max(1, Math.ceil(hoursLeft / 24));
        console.log(`   → ${sub.client_name} (${sub.email}): ${sub.service_name} - ${daysLeft} días restantes`);

        await sendSubscriptionExpiringEmail(
          sub.email,
          sub.client_name,
          daysLeft,
          sub.service_name,
          sub.price_monthly
        );
      }
    } else {
      console.log('✅ [CRON] No hay suscripciones por vencer');
    }

    return result.rows.length;
  } catch (error) {
    console.error('❌ [CRON] Error notificando suscripciones:', error);
    return 0;
  }
}

/**
 * Expirar suscripciones pagas vencidas
 * (Para clientes que no renovaron su pago)
 */
async function expireSubscriptions() {
  console.log('💳 [CRON] Verificando suscripciones vencidas...');

  try {
    // Obtener info antes de expirar (para enviar emails)
    const toExpire = await query(`
      SELECT cs.id, cs.client_id,
             c.email, c.name as client_name,
             s.name as service_name, s.price_monthly
      FROM client_services cs
      JOIN clients c ON cs.client_id = c.id
      JOIN services s ON cs.service_id = s.id
      WHERE cs.status = 'active'
        AND cs.subscription_ends_at IS NOT NULL
        AND cs.subscription_ends_at <= CURRENT_TIMESTAMP
    `);

    // Marcar como expirados
    const result = await query(`
      UPDATE client_services
      SET status = 'expired',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
        AND subscription_ends_at IS NOT NULL
        AND subscription_ends_at <= CURRENT_TIMESTAMP
      RETURNING id, client_id
    `);

    if (result.rowCount > 0) {
      console.log(`💳 [CRON] ${result.rowCount} suscripciones expiradas`);

      // Enviar email a cada cliente
      for (const sub of toExpire.rows) {
        console.log(`   → Suscripción expirada: ${sub.client_name} - ${sub.service_name}`);
        await sendSubscriptionExpiredEmail(
          sub.email,
          sub.client_name,
          sub.service_name,
          sub.price_monthly
        );
      }
    } else {
      console.log('✅ [CRON] No hay suscripciones vencidas');
    }

    return result.rowCount;
  } catch (error) {
    console.error('❌ [CRON] Error expirando suscripciones:', error);
    return 0;
  }
}

module.exports = {
  expireTrials,
  notifyExpiringTrials,
  notifyExpiringSubscriptions,
  expireSubscriptions
};
