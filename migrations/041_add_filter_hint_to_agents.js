const { query } = require('../src/config/database');

exports.up = async () => {
  await query(`ALTER TABLE b2b_agents ADD COLUMN IF NOT EXISTS filter_hint TEXT`);
  console.log('  ✓ b2b_agents.filter_hint added');
};

exports.down = async () => {
  await query(`ALTER TABLE b2b_agents DROP COLUMN IF EXISTS filter_hint`);
};
