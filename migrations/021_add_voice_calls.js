/**
 * Migration 021: Voice Calls — Sistema de llamadas IA via WhatsApp Business + Voximplant
 * - voice_calls: registra cada llamada con transcripción, duración y costo
 */
const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 021: Voice calls table...');

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS voice_calls (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_service_id   UUID REFERENCES client_services(id) ON DELETE CASCADE,
        voximplant_call_id  VARCHAR(200) UNIQUE,
        caller_phone        VARCHAR(30),
        called_phone        VARCHAR(30),
        duration_seconds    INTEGER DEFAULT 0,
        total_exchanges     INTEGER DEFAULT 0,
        status              VARCHAR(30) DEFAULT 'active',
        -- active | resolved | transferred | abandoned | out_of_hours | no_balance | error
        transfer_reason     VARCHAR(50),
        -- user_requested | timeout | ai_error | no_balance | out_of_hours
        transcript          JSONB DEFAULT '[]',
        -- [{role: 'user'|'bot', text: string, timestamp: ISO}]
        cost_usd            NUMERIC(10, 6) DEFAULT 0,
        billed_usd          NUMERIC(10, 6) DEFAULT 0,
        created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        ended_at            TIMESTAMP WITH TIME ZONE
      )
    `);
    console.log('  ✅ voice_calls table created');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  voice_calls already exists');
    } else throw e;
  }

  // Índices para búsquedas frecuentes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_voice_calls_client_service ON voice_calls(client_service_id)`,
    `CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status)`,
    `CREATE INDEX IF NOT EXISTS idx_voice_calls_created_at ON voice_calls(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_voice_calls_voximplant_id ON voice_calls(voximplant_call_id)`,
  ];

  for (const idx of indexes) {
    try {
      await query(idx);
    } catch (e) {
      console.error('  ⚠️  Index error:', e.message);
    }
  }
  console.log('  ✅ Indexes created');

  console.log('✅ Migration 021 completed: Voice calls system ready');
}

module.exports = { up: run, run };
