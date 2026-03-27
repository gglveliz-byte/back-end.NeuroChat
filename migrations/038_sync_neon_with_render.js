const { query } = require('../src/config/database');

async function up() {
    console.log('🔧 Iniciando sincronización masiva Neon -> Render...');

    try {
        // 1. Tabla services
        console.log('  Actualizando tabla [services]...');
        await query(`
            ALTER TABLE services
            ADD COLUMN IF NOT EXISTS features_basic JSONB DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS features_pro JSONB DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS features_pro_handover JSONB DEFAULT '[]',
            ADD COLUMN IF NOT EXISTS quick_replies JSONB DEFAULT '[]'
        `);

        // 2. Tabla products
        console.log('  Actualizando tabla [products]...');
        await query(`
            ALTER TABLE products
            ADD COLUMN IF NOT EXISTS min_price NUMERIC(10, 2) DEFAULT 0.00,
            ADD COLUMN IF NOT EXISTS offer_price NUMERIC(10, 2) DEFAULT 0.00
        `);

        // 3. Tabla admins
        console.log('  Actualizando tabla [admins]...');
        await query(`
            ALTER TABLE admins
            ADD COLUMN IF NOT EXISTS last_login TIMESTAMP
        `);

        // 4. Tabla clients
        console.log('  Actualizando tabla [clients]...');
        await query(`
            ALTER TABLE clients
            ADD COLUMN IF NOT EXISTS last_login TIMESTAMP
        `);

        console.log('✅ Sincronización masiva completada con éxito.');

    } catch (err) {
        console.error('❌ Error en sincronización masiva 038:', err.message);
        throw err;
    }
}

module.exports = { up, run: up };
