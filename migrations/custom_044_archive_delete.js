const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const query = (text, params) => pool.query(text, params);

async function migrate() {
    try {
        console.log('--- Migración: Agregar soporte para archivar y eliminar ---');
        
        await query('SET search_path TO chatbot_saas, public');

        // Agregar columna deleted_at
        await query(`
            ALTER TABLE b2b_web_conversations 
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
        `);
        console.log('  ✓ Columna deleted_at añadida');

        // Asegurar que el índice contemple el borrado lógico
        await query(`
            CREATE INDEX IF NOT EXISTS idx_b2b_web_conversations_deleted ON b2b_web_conversations(deleted_at) WHERE deleted_at IS NULL;
        `);
        console.log('  ✓ Índice de borrado lógico creado');

        console.log('--- Migración completada con éxito ---');
        process.exit(0);
    } catch (err) {
        console.error('Error en migración:', err);
        process.exit(1);
    }
}

migrate();
