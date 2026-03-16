/**
 * Migration 019: Add business_hours and payment_config to businesses table
 * These are now GLOBAL per-client (not per-service/bot), so they live in businesses.
 * - business_hours: opening schedule for all platforms
 * - payment_config: bank account info for receiving transfers
 */
const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 019: Adding business_hours + payment_config to businesses...');

  try {
    await query(`
      ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}'
    `);
    console.log('  ✅ business_hours column added to businesses');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  business_hours already exists');
    } else throw e;
  }

  try {
    await query(`
      ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS payment_config JSONB DEFAULT '{}'
    `);
    console.log('  ✅ payment_config column added to businesses');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  payment_config already exists');
    } else throw e;
  }

  console.log('✅ Migration 019 completed: business-level hours and payment config ready');
}

module.exports = { up: run, run };
