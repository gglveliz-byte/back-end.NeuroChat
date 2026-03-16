/**
 * Migration 025: Add UNIQUE INDEX on conversations(client_service_id, contact_id)
 *
 * Prevents duplicate conversations for the same contact on the same service.
 * Required for ON CONFLICT upsert pattern in webhookController.
 *
 * Also cleans up any existing duplicates before creating the index.
 */

const { pool } = require('../src/config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO chatbot_saas');
    await client.query('BEGIN');

    // Step 1: Clean up existing duplicates (keep the oldest conversation)
    console.log('Cleaning up duplicate conversations...');
    const dupes = await client.query(`
      DELETE FROM conversations
      WHERE id NOT IN (
        SELECT MIN(id) FROM conversations
        GROUP BY client_service_id, contact_id
      )
      RETURNING id
    `);
    if (dupes.rowCount > 0) {
      console.log(`  Removed ${dupes.rowCount} duplicate conversations`);
    }

    // Step 2: Create unique index
    console.log('Creating unique index on conversations(client_service_id, contact_id)...');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_service_contact_unique
      ON conversations (client_service_id, contact_id)
    `);

    await client.query('COMMIT');
    console.log('Migration 025 completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 025 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { run };
