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

    // Agregar columnas phone y email a businesses
    console.log('Agregando columnas phone y email a businesses...');
    await client.query(`
      ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS email VARCHAR(255)
    `);

    console.log('\n✅ Migración completada exitosamente\n');

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
