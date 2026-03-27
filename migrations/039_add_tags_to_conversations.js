const { query } = require('../src/config/database');

async function up() {
    console.log('🔧 Añadiendo columna [tags] a la tabla [conversations]...');

    try {
        await query(`
            ALTER TABLE conversations
            ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'
        `);
        console.log('✅ Columna [tags] añadida con éxito.');
    } catch (err) {
        console.error('❌ Error al añadir columna [tags]:', err.message);
        throw err;
    }
}

module.exports = { up, run: up };
