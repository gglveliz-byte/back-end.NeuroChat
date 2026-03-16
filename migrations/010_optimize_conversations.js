const { query } = require('../src/config/database');

/**
 * Migration: Optimize conversations table with indexes
 * Adds indexes for status, contact_id, and (client_service_id, status)
 * to improve query performance for common access patterns.
 */

const up = async () => {
    console.log('Running migration 010: Optimize conversations table...');

    // Note: CONCURRENTLY removed — incompatible with transaction blocks in migration runner
    await query(`CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_conversations_client_status ON conversations(client_service_id, status)`);

    console.log('✅ Migration 010 completed successfully');
};

const down = async () => {
    console.log('Rolling back migration 010...');

    await query(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_status;
    DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_contact_id;
    DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_client_status;
  `);

    console.log('Migration 010 rolled back');
};

module.exports = { up, down };
