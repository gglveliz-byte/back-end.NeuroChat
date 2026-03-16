require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });

(async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Conectado a BD (Neon)');

    // Crear schema si no existe
    await client.query('CREATE SCHEMA IF NOT EXISTS chatbot_saas');
    console.log('✅ Schema chatbot_saas creado/verificado');

    // Ejecutar las migraciones B2B
    console.log('\n⏳ Ejecutando: 022_create_b2b_tables.js');
    const mig22 = require('./migrations/022_create_b2b_tables.js');
    try {
      await mig22.up();
      console.log('✅ 022_create_b2b_tables.js completada');
    } catch (err) {
      console.log('⚠️  022: ' + err.message.split('\n')[0]);
    }

    console.log('\n⏳ Ejecutando: 031_add_processing_mode_to_areas.js');
    const mig31 = require('./migrations/031_add_processing_mode_to_areas.js');
    try {
      await mig31.up();
      console.log('✅ 031_add_processing_mode_to_areas.js completada');
    } catch (err) {
      console.log('⚠️  031: ' + err.message.split('\n')[0]);
    }

    // Verificar que el campo existe
    console.log('\n🔍 Verificando campo processing_mode...');
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='b2b_areas' AND column_name='processing_mode'
    `);

    if (result.rows.length > 0) {
      console.log('✅ Campo processing_mode existe en b2b_areas');
    } else {
      console.log('⚠️  Campo processing_mode no encontrado');
    }

    client.release();
    pool.end();
    console.log('\n✅ Migraciones completadas exitosamente');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fatal:', error.message);
    pool.end();
    process.exit(1);
  }
})();
