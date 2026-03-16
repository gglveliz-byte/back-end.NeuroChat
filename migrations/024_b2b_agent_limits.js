const { query } = require('../src/config/database');

exports.up = async () => {
  await query(`
    ALTER TABLE b2b_clients
    ADD COLUMN IF NOT EXISTS max_agents_per_area INTEGER DEFAULT 5 NOT NULL
  `);

  console.log('  ✓ b2b_clients: max_agents_per_area added (default: 5)');
};
