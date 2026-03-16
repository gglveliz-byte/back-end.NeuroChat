/**
 * Migration 018: Add payment_config JSONB to bot_configs
 * - payment_config: per-client bank account / payment instructions
 *   {
 *     enabled: boolean,
 *     bank_name: string,
 *     account_holder: string,
 *     account_number: string,
 *     account_type: string,        // "Ahorros" | "Corriente"
 *     id_number: string,           // Cédula / RUC del titular
 *     instructions: string         // Texto libre para el cliente
 *   }
 */
const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 018: Adding payment_config to bot_configs...');

  try {
    await query(`
      ALTER TABLE bot_configs
      ADD COLUMN IF NOT EXISTS payment_config JSONB DEFAULT '{}'
    `);
    console.log('  ✅ payment_config column added to bot_configs');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  payment_config already exists');
    } else throw e;
  }

  console.log('✅ Migration 018 completed: payment_config ready');
}

module.exports = { up: run, run };
