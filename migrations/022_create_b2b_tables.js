const { query } = require('../src/config/database');

exports.up = async () => {
    // ─── b2b_clients ─────────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_clients (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_name    VARCHAR(255) NOT NULL,
      contact_name    VARCHAR(255) NOT NULL,
      email           VARCHAR(255) UNIQUE NOT NULL,
      password_hash   VARCHAR(255) NOT NULL,
      ai_provider     VARCHAR(50) NOT NULL,
      ai_api_key      TEXT NOT NULL,
      ai_model        VARCHAR(100) NOT NULL,
      status          VARCHAR(20) DEFAULT 'active',
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_clients');

    // ─── b2b_areas ───────────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_areas (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id   UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      name            VARCHAR(100) NOT NULL,
      display_name    VARCHAR(255) NOT NULL,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_areas');

    // ─── b2b_agents ──────────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_agents (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_area_id     UUID NOT NULL REFERENCES b2b_areas(id) ON DELETE CASCADE,
      type            VARCHAR(50) NOT NULL,
      name            VARCHAR(100) NOT NULL,
      system_prompt   TEXT,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_agents');

    // ─── b2b_interactions ────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_interactions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_area_id     UUID NOT NULL REFERENCES b2b_areas(id) ON DELETE CASCADE,
      channel         VARCHAR(20) NOT NULL,
      source_id       VARCHAR(255),
      raw_text        TEXT NOT NULL,
      filter_result   JSONB,
      assigned_agent  VARCHAR(50),
      agent_result    JSONB,
      status          VARCHAR(30) DEFAULT 'pendiente',
      human_reviewer  VARCHAR(255),
      human_feedback  TEXT,
      reprocess_count INTEGER DEFAULT 0,
      processed_at    TIMESTAMP,
      reviewed_at     TIMESTAMP,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_interactions');

    // ─── b2b_exports ─────────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_exports (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_area_id     UUID NOT NULL REFERENCES b2b_areas(id) ON DELETE CASCADE,
      date_from       DATE NOT NULL,
      date_to         DATE NOT NULL,
      total_records   INTEGER NOT NULL,
      file_url        TEXT,
      created_by      VARCHAR(255),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_exports');

    // ─── Índices ─────────────────────────────────────────────────
    await query(`
    CREATE INDEX IF NOT EXISTS idx_b2b_areas_client ON b2b_areas(b2b_client_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_agents_area ON b2b_agents(b2b_area_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_interactions_area ON b2b_interactions(b2b_area_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_interactions_status ON b2b_interactions(status);
    CREATE INDEX IF NOT EXISTS idx_b2b_interactions_created ON b2b_interactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_b2b_exports_area ON b2b_exports(b2b_area_id)
  `);
    console.log('  ✓ Índices B2B');
};
