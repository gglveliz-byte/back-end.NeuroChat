const { query } = require('../src/config/database');

/**
 * Migration: Add message usage tracking table
 * Tracks daily message counts per client service for enforcing limits
 */

const up = async () => {
  console.log('Running migration 007: Add message usage tracking...');

  // Create message_usage table
  await query(`
    CREATE TABLE IF NOT EXISTS message_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_service_id UUID NOT NULL REFERENCES client_services(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_service_id, date)
    )
  `);

  // Create index for fast lookups
  await query(`
    CREATE INDEX IF NOT EXISTS idx_message_usage_service_date
    ON message_usage(client_service_id, date DESC)
  `);

  console.log('✅ Migration 007 completed successfully');
};

const down = async () => {
  await query('DROP TABLE IF EXISTS message_usage');
  console.log('Migration 007 rolled back');
};

module.exports = { up, down };
