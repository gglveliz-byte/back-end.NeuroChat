const { query } = require('../src/config/database');

const up = async () => {
  console.log('Running migration 004: Add knowledge_files table...');

  await query(`
    CREATE TABLE IF NOT EXISTS knowledge_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_service_id UUID NOT NULL REFERENCES client_services(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      file_type VARCHAR(50) NOT NULL,
      extracted_text TEXT,
      file_size INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_files_client_service
    ON knowledge_files(client_service_id)
  `);

  console.log('Migration 004 completed successfully');
};

const down = async () => {
  await query('DROP TABLE IF EXISTS knowledge_files');
  console.log('Migration 004 rolled back');
};

module.exports = { up, down };
