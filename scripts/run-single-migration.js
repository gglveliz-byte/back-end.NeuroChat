require('dotenv').config();
const { query, pool } = require('../src/config/database');
const migration = require('../migrations/008_add_conversation_message_tracking.js');

async function runMigration() {
  console.log('\n🔄 Running migration 008...\n');

  try {
    await migration.up();

    // Register migration
    await query(
      'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      ['008_add_conversation_message_tracking.js']
    );

    console.log('\n✅ Migration completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
