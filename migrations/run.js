require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query } = require('../src/config/database');

async function runMigrations() {
  try {
    // Crear schema y extensiones si no existen (necesario en DB nueva)
    await query(`CREATE SCHEMA IF NOT EXISTS chatbot_saas`);
    await query(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log('✅ Schema chatbot_saas y extensión vector listos\n');

    // Crear tabla de migraciones si no existe
    await query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Obtener migraciones ya ejecutadas
    const result = await query('SELECT name FROM migrations');
    const executedMigrations = result.rows.map(row => row.name);

    // Obtener archivos de migración
    const migrationFiles = fs.readdirSync(__dirname)
      .filter(file => file.endsWith('.js') && file !== 'run.js')
      .sort();

    console.log(`\n📦 Found ${migrationFiles.length} migration files\n`);

    // Ejecutar migraciones pendientes
    for (const file of migrationFiles) {
      if (!executedMigrations.includes(file)) {
        console.log(`⏳ Running migration: ${file}`);
        const migration = require(path.join(__dirname, file));

        // Soportar varios formatos de export: { up }, { run }, o función directa
        const migrationFn = migration.up || migration.run || (typeof migration === 'function' ? migration : null);
        if (!migrationFn) {
          console.log(`  ⚠️  Skipping ${file}: no exporta una función up/run compatible`);
          await query('INSERT INTO migrations (name) VALUES ($1)', [file]);
          continue;
        }
        await migrationFn();

        await query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        console.log(`✅ Migration completed: ${file}\n`);
      } else {
        console.log(`⏭️  Skipping (already executed): ${file}`);
      }
    }

    console.log('\n✨ All migrations completed successfully!\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
