const { query } = require('../src/config/database');

exports.up = async () => {
    // ─── b2b_web_configs ─────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_configs (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id       UUID NOT NULL UNIQUE REFERENCES b2b_clients(id) ON DELETE CASCADE,
      welcome_message     TEXT DEFAULT 'Hola! ¿En qué puedo ayudarte hoy?',
      widget_color        VARCHAR(20) DEFAULT '#0ea5e9',
      widget_position     VARCHAR(10) DEFAULT 'right',
      widget_delay_seconds INT DEFAULT 3,
      system_prompt       TEXT,
      google_maps_api_key VARCHAR(500),
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_configs');

    // ─── b2b_web_scrape_urls ─────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_scrape_urls (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id     UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      url               TEXT NOT NULL,
      label             VARCHAR(255),
      last_scraped_at   TIMESTAMP,
      scrape_status     VARCHAR(20) DEFAULT 'pending',
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_scrape_urls');

    // ─── b2b_web_scraped_content ─────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_scraped_content (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scrape_url_id     UUID NOT NULL REFERENCES b2b_web_scrape_urls(id) ON DELETE CASCADE,
      b2b_client_id     UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      raw_html          TEXT,
      extracted_text    TEXT,
      scraped_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_scraped_content');

    // ─── b2b_web_knowledge_chunks ────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_knowledge_chunks (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id     UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      scrape_url_id     UUID REFERENCES b2b_web_scrape_urls(id) ON DELETE SET NULL,
      chunk_index       INT NOT NULL,
      content           TEXT NOT NULL,
      embedding         vector(1536),
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_knowledge_chunks');

    // ─── b2b_web_oauth_configs ───────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_oauth_configs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id     UUID NOT NULL UNIQUE REFERENCES b2b_clients(id) ON DELETE CASCADE,
      token_url         TEXT NOT NULL,
      client_id         VARCHAR(500),
      client_secret     TEXT,
      grant_type        VARCHAR(50) DEFAULT 'client_credentials',
      cached_token      TEXT,
      token_expires_at  TIMESTAMP,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_oauth_configs');

    // ─── b2b_web_api_endpoints ───────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_api_endpoints (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id     UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      endpoint_type     VARCHAR(30) NOT NULL,
      url               TEXT NOT NULL,
      http_method       VARCHAR(10) DEFAULT 'POST',
      channel_id        VARCHAR(100),
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_api_endpoints');

    // ─── b2b_web_conversations ───────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_conversations (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      b2b_client_id           UUID NOT NULL REFERENCES b2b_clients(id) ON DELETE CASCADE,
      visitor_id              VARCHAR(255),
      customer_name           VARCHAR(255),
      customer_phone          VARCHAR(50),
      customer_email          VARCHAR(255),
      customer_document_type  VARCHAR(20),
      customer_document_number VARCHAR(50),
      location_lat            DECIMAL(10,8),
      location_lng            DECIMAL(11,8),
      location_city           VARCHAR(255),
      location_address        TEXT,
      coverage_status         VARCHAR(20) DEFAULT 'pending',
      lead_submitted          BOOLEAN DEFAULT false,
      lead_external_id        VARCHAR(255),
      status                  VARCHAR(20) DEFAULT 'active',
      created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_conversations');

    // ─── b2b_web_messages ────────────────────────────────────────
    await query(`
    CREATE TABLE IF NOT EXISTS b2b_web_messages (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id   UUID NOT NULL REFERENCES b2b_web_conversations(id) ON DELETE CASCADE,
      role              VARCHAR(20) NOT NULL,
      content           TEXT NOT NULL,
      metadata          JSONB,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('  ✓ b2b_web_messages');

    // ─── Índices ─────────────────────────────────────────────────
    await query(`
    CREATE INDEX IF NOT EXISTS idx_b2b_web_scrape_urls_client ON b2b_web_scrape_urls(b2b_client_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_scraped_content_url ON b2b_web_scraped_content(scrape_url_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_knowledge_client ON b2b_web_knowledge_chunks(b2b_client_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_conversations_client ON b2b_web_conversations(b2b_client_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_conversations_status ON b2b_web_conversations(status);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_messages_conv ON b2b_web_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_messages_created ON b2b_web_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_b2b_web_api_endpoints_client ON b2b_web_api_endpoints(b2b_client_id)
  `);
    console.log('  ✓ Índices Agente Web');
};
