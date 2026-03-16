const { query } = require('../src/config/database');

exports.up = async () => {
  await query(`
    ALTER TABLE b2b_areas
    ADD COLUMN IF NOT EXISTS processing_mode VARCHAR(20) DEFAULT 'manual'
  `);
  console.log('  ✓ Added processing_mode column to b2b_areas');
};

exports.down = async () => {
  await query(`
    ALTER TABLE b2b_areas
    DROP COLUMN IF EXISTS processing_mode
  `);
  console.log('  ✓ Removed processing_mode column from b2b_areas');
};
