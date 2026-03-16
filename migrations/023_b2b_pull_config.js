const { query } = require('../src/config/database');

exports.up = async () => {
  // Add PULL ingestion config (JSONB) and last fetch timestamp to b2b_clients
  await query(`
    ALTER TABLE b2b_clients
    ADD COLUMN IF NOT EXISTS pull_config JSONB DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMP DEFAULT NULL
  `);

  console.log('  ✓ b2b_clients: pull_config + last_fetched_at added');
};
