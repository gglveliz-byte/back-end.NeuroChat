const { query } = require('../src/config/database');

exports.up = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS b2b_token_usage (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id   UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      interaction_id  UUID REFERENCES b2b_interactions(id) ON DELETE SET NULL,
      step            VARCHAR(50) NOT NULL,
      model           VARCHAR(100) NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      cost_usd        DECIMAL(10, 6) NOT NULL DEFAULT 0,
      created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  console.log('  ✓ b2b_token_usage');

  await query(`CREATE INDEX IF NOT EXISTS idx_b2b_token_usage_client ON b2b_token_usage(b2b_client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_b2b_token_usage_interaction ON b2b_token_usage(interaction_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_b2b_token_usage_created ON b2b_token_usage(created_at)`);
  console.log('  ✓ indexes b2b_token_usage');
};

exports.down = async () => {
  await query(`DROP TABLE IF EXISTS b2b_token_usage`);
};
