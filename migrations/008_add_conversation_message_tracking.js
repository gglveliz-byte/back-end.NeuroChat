const { query } = require('../src/config/database');

/**
 * Migration: Add conversation message tracking table
 * Tracks daily message counts per conversation to prevent abuse from single users
 */

const up = async () => {
  console.log('Running migration 008: Add conversation message tracking...');

  // Create conversation_message_usage table
  await query(`
    CREATE TABLE IF NOT EXISTS conversation_message_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(conversation_id, date)
    )
  `);

  // Create index for fast lookups
  await query(`
    CREATE INDEX IF NOT EXISTS idx_conversation_message_usage_conv_date
    ON conversation_message_usage(conversation_id, date DESC)
  `);

  console.log('✅ Migration 008 completed successfully');
};

const down = async () => {
  await query('DROP TABLE IF EXISTS conversation_message_usage');
  console.log('Migration 008 rolled back');
};

module.exports = { up, down };
