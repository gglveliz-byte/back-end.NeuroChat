const { query } = require('../src/config/database');

async function up() {
    console.log('🔧 Migration 037: Adding slug to businesses table...');
    
    try {
        await query(`
            ALTER TABLE businesses
            ADD COLUMN IF NOT EXISTS slug VARCHAR(255) UNIQUE
        `);
        console.log('  ✅ slug column added to businesses table');
        console.log('  ✅ Slugs populated for existing businesses');

    } catch (err) {
        console.error('❌ Error in migration 037:', err.message);
        throw err;
    }
}

module.exports = { up, run: up };
