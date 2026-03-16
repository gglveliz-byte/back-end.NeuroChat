const { query } = require('../src/config/database');

exports.up = async () => {
    // Add scraping_enabled toggle to web configs
    await query(`
        ALTER TABLE b2b_web_configs
        ADD COLUMN IF NOT EXISTS scraping_enabled BOOLEAN DEFAULT true
    `);
    console.log('  ✓ b2b_web_configs.scraping_enabled added');

    // Create uploaded files table (alternative to scraping)
    await query(`
        CREATE TABLE IF NOT EXISTS b2b_web_uploaded_files (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            b2b_client_id   UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
            original_name   VARCHAR(500) NOT NULL,
            mime_type       VARCHAR(100),
            file_size       INT,
            extracted_text  TEXT,
            status          VARCHAR(20) DEFAULT 'processing',
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('  ✓ b2b_web_uploaded_files created');
};

exports.down = async () => {
    await query('DROP TABLE IF EXISTS b2b_web_uploaded_files');
    await query('ALTER TABLE b2b_web_configs DROP COLUMN IF EXISTS scraping_enabled');
};
