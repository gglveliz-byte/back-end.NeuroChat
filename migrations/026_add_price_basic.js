/**
 * Migration 026: Add price_basic column
 * Fixes a bug where price_basic is queried but missing in local dev DB schemas
 */
const { query } = require('../src/config/database');

async function run() {
    console.log('🔧 Migration 026: Adding price_basic column to services and client_services...');

    try {
        await query(`
      ALTER TABLE services
      ADD COLUMN IF NOT EXISTS price_basic NUMERIC(10, 2) DEFAULT 0.00
    `);
        console.log('  ✅ price_basic column added to services');
    } catch (e) {
        if (e.message.includes('already exists')) {
            console.log('  ⏭️  price_basic already exists in services');
        } else throw e;
    }

    try {
        await query(`
      ALTER TABLE client_services
      ADD COLUMN IF NOT EXISTS price_basic NUMERIC(10, 2) DEFAULT 0.00
    `);
        console.log('  ✅ price_basic column added to client_services');
    } catch (e) {
        if (e.message.includes('already exists')) {
            console.log('  ⏭️  price_basic already exists in client_services');
        } else throw e;
    }

    console.log('✅ Migration 026 completed');
}

module.exports = { up: run, run };
