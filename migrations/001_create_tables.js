require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL no está configurada. Crea un archivo .env con la variable.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Iniciando migración...\n');

    // Crear esquema específico para el proyecto
    console.log('Creando esquema chatbot_saas...');
    await client.query('CREATE SCHEMA IF NOT EXISTS chatbot_saas');

    // Establecer search_path al nuevo esquema
    await client.query('SET search_path TO chatbot_saas');
    console.log('Esquema establecido: chatbot_saas\n');

    // Crear tabla admins
    console.log('Creando tabla admins...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Crear tabla clients
    console.log('Creando tabla clients...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        status VARCHAR(20) DEFAULT 'active',
        email_verified BOOLEAN DEFAULT false,
        email_verified_at TIMESTAMP,
        created_by UUID REFERENCES admins(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Crear tabla businesses
    console.log('Creando tabla businesses...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        industry VARCHAR(100),
        description TEXT,
        country VARCHAR(100),
        address TEXT,
        website VARCHAR(255),
        logo_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla services
    console.log('Creando tabla services...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        code VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        price_monthly DECIMAL(10,2) NOT NULL,
        icon VARCHAR(100),
        color VARCHAR(20),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla client_services
    console.log('Creando tabla client_services...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        service_id UUID REFERENCES services(id),
        status VARCHAR(20) DEFAULT 'trial',
        config JSONB DEFAULT '{}',
        trial_started_at TIMESTAMP,
        trial_ends_at TIMESTAMP,
        subscription_started_at TIMESTAMP,
        subscription_ends_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(client_id, service_id)
      )
    `);

    // Crear tabla conversations
    console.log('Creando tabla conversations...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_service_id UUID REFERENCES client_services(id) ON DELETE CASCADE,
        contact_id VARCHAR(255) NOT NULL,
        contact_name VARCHAR(200),
        contact_phone VARCHAR(50),
        contact_email VARCHAR(255),
        platform VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        is_bot_active BOOLEAN DEFAULT true,
        unread_count INTEGER DEFAULT 0,
        last_message_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(client_service_id, contact_id)
      )
    `);

    // Crear tabla messages
    console.log('Creando tabla messages...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        sender_type VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(20) DEFAULT 'text',
        media_url VARCHAR(500),
        external_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'sent',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla bot_configs
    console.log('Creando tabla bot_configs...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_service_id UUID UNIQUE REFERENCES client_services(id) ON DELETE CASCADE,
        welcome_message TEXT,
        away_message TEXT,
        fallback_message TEXT,
        personality VARCHAR(50) DEFAULT 'friendly',
        language VARCHAR(10) DEFAULT 'es',
        knowledge_base JSONB DEFAULT '{}',
        business_hours JSONB DEFAULT '{}',
        ai_config JSONB DEFAULT '{"model": "gpt-3.5-turbo", "temperature": 0.7, "max_tokens": 500}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla payments
    console.log('Creando tabla payments...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id),
        client_service_id UUID REFERENCES client_services(id),
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD',
        method VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        reference VARCHAR(100) UNIQUE,
        paypal_order_id VARCHAR(255),
        paypal_capture_id VARCHAR(255),
        receipt_url VARCHAR(500),
        notes TEXT,
        validated_by UUID REFERENCES admins(id),
        validated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla email_verifications
    console.log('Creando tabla email_verifications...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        code VARCHAR(6) NOT NULL,
        type VARCHAR(20) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla refresh_tokens
    console.log('Creando tabla refresh_tokens...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_type VARCHAR(20) NOT NULL,
        token VARCHAR(500) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear tabla audit_logs
    console.log('Creando tabla audit_logs...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_type VARCHAR(20) NOT NULL,
        user_id UUID NOT NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id UUID,
        details JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Crear índices
    console.log('Creando índices...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
      CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
      CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id);
      CREATE INDEX IF NOT EXISTS idx_client_services_status ON client_services(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_client_service ON conversations(client_service_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_type, user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, user_type)
    `);

    console.log('\n✅ Todas las tablas e índices creados exitosamente\n');

    // Verificar tablas creadas
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'chatbot_saas'
      ORDER BY table_name
    `);

    console.log('Tablas en el esquema chatbot_saas:');
    result.rows.forEach(row => {
      console.log('  ✓ ' + row.table_name);
    });

  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    console.error('Detalle:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
