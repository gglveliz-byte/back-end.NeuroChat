const { query } = require('../src/config/database');

module.exports = async function migrate() {
  console.log('Migration 030: Add voice_metrics column to b2b_interactions...');

  await query(`
    ALTER TABLE b2b_interactions
    ADD COLUMN IF NOT EXISTS voice_metrics JSONB
  `);

  console.log('  voice_metrics column added');
};
