/**
 * Migration 004: Add v2 multi-layer columns to b2b_agents
 * Adds description, evaluation_template, deliverable_template, feedback_accumulated
 */
require('dotenv').config();
const { query } = require('../src/config/database');

exports.up = async () => {
    console.log('🔄 Starting migration: Add agent v2 columns...');

    await query(`
      ALTER TABLE b2b_agents
        ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS evaluation_template TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS deliverable_template TEXT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS feedback_accumulated TEXT DEFAULT NULL;
    `);

    console.log('  ✓ Added columns: description, evaluation_template, deliverable_template, feedback_accumulated');
};

// Run directly if called with node
if (require.main === module) {
    exports.up()
        .then(() => {
            console.log('✅ Migration completed!');
            process.exit(0);
        })
        .catch(err => {
            console.error('❌ Migration failed:', err.message);
            process.exit(1);
        });
}
