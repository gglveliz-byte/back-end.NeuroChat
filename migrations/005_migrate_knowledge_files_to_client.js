const { query } = require('../src/config/database');

const up = async () => {
  console.log('Running migration 005: Migrate knowledge_files to client-level...');

  // 1. Crear nueva tabla con client_id en lugar de client_service_id
  await query(`
    CREATE TABLE IF NOT EXISTS client_knowledge_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      file_type VARCHAR(50) NOT NULL,
      extracted_text TEXT,
      file_size INTEGER DEFAULT 0,
      text_length INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_client_knowledge_files_client
    ON client_knowledge_files(client_id)
  `);

  // 2. Migrar datos existentes (si los hay)
  // Esto toma los PDFs de cada servicio y los asocia al cliente
  // Evita duplicados por filename
  await query(`
    INSERT INTO client_knowledge_files (client_id, filename, file_type, extracted_text, file_size, text_length, created_at)
    SELECT DISTINCT ON (cs.client_id, kf.filename)
      cs.client_id,
      kf.filename,
      kf.file_type,
      kf.extracted_text,
      kf.file_size,
      LENGTH(kf.extracted_text) as text_length,
      kf.created_at
    FROM knowledge_files kf
    INNER JOIN client_services cs ON kf.client_service_id = cs.id
    ORDER BY cs.client_id, kf.filename, kf.created_at DESC
    ON CONFLICT DO NOTHING
  `);

  console.log('Migration 005 completed successfully');
};

const down = async () => {
  await query('DROP TABLE IF EXISTS client_knowledge_files');
  console.log('Migration 005 rolled back');
};

module.exports = { up, down };
