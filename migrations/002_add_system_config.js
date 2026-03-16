require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL no está configurada.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Iniciando migración 002...\n');

    // Establecer search_path al esquema
    await client.query('SET search_path TO chatbot_saas');
    console.log('Esquema establecido: chatbot_saas\n');

    // Crear tabla system_config
    console.log('Creando tabla system_config...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        description TEXT,
        created_by UUID REFERENCES admins(id),
        updated_by UUID REFERENCES admins(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Agregar columna transaction_id a payments si no existe
    console.log('Verificando columna transaction_id en payments...');
    const columnExists = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'chatbot_saas'
        AND table_name = 'payments'
        AND column_name = 'transaction_id'
    `);

    if (columnExists.rows.length === 0) {
      console.log('Agregando columna transaction_id a payments...');
      await client.query(`
        ALTER TABLE payments ADD COLUMN transaction_id VARCHAR(255)
      `);
    }

    // Agregar columna paid_at a payments si no existe
    console.log('Verificando columna paid_at en payments...');
    const paidAtExists = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'chatbot_saas'
        AND table_name = 'payments'
        AND column_name = 'paid_at'
    `);

    if (paidAtExists.rows.length === 0) {
      console.log('Agregando columna paid_at a payments...');
      await client.query(`
        ALTER TABLE payments ADD COLUMN paid_at TIMESTAMP
      `);
    }

    // Agregar columnas phone y email a businesses si no existen
    console.log('Verificando columnas adicionales en businesses...');
    const phoneExists = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'chatbot_saas'
        AND table_name = 'businesses'
        AND column_name = 'phone'
    `);

    if (phoneExists.rows.length === 0) {
      console.log('Agregando columna phone a businesses...');
      await client.query(`
        ALTER TABLE businesses ADD COLUMN phone VARCHAR(50)
      `);
    }

    const emailExists = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'chatbot_saas'
        AND table_name = 'businesses'
        AND column_name = 'email'
    `);

    if (emailExists.rows.length === 0) {
      console.log('Agregando columna email a businesses...');
      await client.query(`
        ALTER TABLE businesses ADD COLUMN email VARCHAR(255)
      `);
    }

    // Crear índice para system_config
    console.log('Creando índices...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_system_config_key ON system_config(key)
    `);

    console.log('\n✅ Migración 002 completada exitosamente\n');

    // Verificar tablas actualizadas
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
