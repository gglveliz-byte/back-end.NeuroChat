require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', (client) => {
  client.query('SET search_path TO chatbot_saas');
});
// =====================================================
// Migración 003: Campos OAuth + Token Management
// + Índice de deduplicación en messages
// =====================================================

async function up() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO chatbot_saas');

    console.log('🔄 Ejecutando migración 003...');

    // ─── Nuevos campos en client_services ───
    console.log('  Agregando campos de token management a client_services...');

    // token_expires_at: Cuándo expira el token de Meta
    await client.query(`
      ALTER TABLE client_services
      ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP
    `);

    // token_refreshed_at: Última vez que se renovó el token
    await client.query(`
      ALTER TABLE client_services
      ADD COLUMN IF NOT EXISTS token_refreshed_at TIMESTAMP
    `);

    // token_status: Estado del token OAuth
    // 'active' | 'expiring_soon' | 'expired' | 'refresh_failed' | 'disconnected'
    await client.query(`
      ALTER TABLE client_services
      ADD COLUMN IF NOT EXISTS token_status VARCHAR(20) DEFAULT 'active'
    `);

    // ─── Índice para deduplicación de mensajes ───
    console.log('  Agregando campo external_id a messages para deduplicación...');

    await client.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS external_id VARCHAR(255)
    `);

    // Índice único para evitar mensajes duplicados del mismo webhook
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
      ON messages(external_id)
      WHERE external_id IS NOT NULL
    `);

    // ─── Índices de rendimiento para los CRON jobs ───
    console.log('  Creando índices de rendimiento...');

    // Índice para buscar tokens que expiran pronto
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cs_token_expires
      ON client_services(token_expires_at)
      WHERE token_expires_at IS NOT NULL AND token_status IN ('active', 'expiring_soon')
    `);

    // Índice para buscar trials que expiran
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cs_trial_expires
      ON client_services(trial_ends_at)
      WHERE status = 'trial' AND trial_ends_at IS NOT NULL
    `);

    // Índice para buscar suscripciones que expiran
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cs_subscription_expires
      ON client_services(subscription_ends_at)
      WHERE status = 'active' AND subscription_ends_at IS NOT NULL
    `);

    // Índice para buscar servicios por platform_account_id en config JSONB
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cs_config_gin
      ON client_services USING GIN (config jsonb_path_ops)
    `);

    await client.query('COMMIT');
    console.log('✅ Migración 003 completada exitosamente');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error en migración 003:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO chatbot_saas');

    await client.query('DROP INDEX IF EXISTS idx_cs_config_gin');
    await client.query('DROP INDEX IF EXISTS idx_cs_subscription_expires');
    await client.query('DROP INDEX IF EXISTS idx_cs_trial_expires');
    await client.query('DROP INDEX IF EXISTS idx_cs_token_expires');
    await client.query('DROP INDEX IF EXISTS idx_messages_external_id');

    await client.query('ALTER TABLE messages DROP COLUMN IF EXISTS external_id');
    await client.query('ALTER TABLE client_services DROP COLUMN IF EXISTS token_status');
    await client.query('ALTER TABLE client_services DROP COLUMN IF EXISTS token_refreshed_at');
    await client.query('ALTER TABLE client_services DROP COLUMN IF EXISTS token_expires_at');

    await client.query('COMMIT');
    console.log('✅ Migración 003 revertida');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Ejecutar si se llama directamente: node migrations/003_oauth_tokens.js
if (require.main === module) {
  const action = process.argv[2] || 'up';

  require('dotenv').config();

  (action === 'down' ? down() : up())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { up, down };
