/**
 * Migration 017: Pay-As-You-Go billing infrastructure
 * - token_usage table: records every AI response with exact token counts + cost
 * - credit_balance on client_services: USD balance for PAYG clients
 */
const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 017: PAYG billing infrastructure...');

  // Add credit_balance to client_services (PAYG clients use this)
  try {
    await query(`
      ALTER TABLE client_services
      ADD COLUMN IF NOT EXISTS credit_balance NUMERIC(10, 4) DEFAULT 0.00
    `);
    console.log('  ✅ credit_balance column added to client_services');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  credit_balance already exists');
    } else throw e;
  }

  // Create token_usage table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        client_service_id UUID REFERENCES client_services(id) ON DELETE SET NULL,
        conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
        message_id        UUID REFERENCES messages(id) ON DELETE SET NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        total_tokens      INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
        provider          VARCHAR(20)  NOT NULL DEFAULT 'openai',
        model             VARCHAR(50)  NOT NULL DEFAULT 'gpt-4o-mini',
        cost_usd          NUMERIC(10, 8) NOT NULL DEFAULT 0,
        billed_usd        NUMERIC(10, 8) NOT NULL DEFAULT 0,
        plan_type         VARCHAR(20),
        created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    console.log('  ✅ token_usage table created');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  token_usage already exists');
    } else throw e;
  }

  // Indexes for fast monthly aggregation queries
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_token_usage_client_id ON token_usage(client_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_token_usage_client_service ON token_usage(client_service_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at)`);
    console.log('  ✅ Indexes created on token_usage');
  } catch (e) {
    console.error('  ⚠️  Indexes error:', e.message);
  }

  console.log('✅ Migration 017 completed: PAYG billing ready');
}

module.exports = { up: run, run };
