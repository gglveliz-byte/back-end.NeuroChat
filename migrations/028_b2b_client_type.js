const { query } = require('../src/config/database');

exports.up = async () => {
    await query(`
        ALTER TABLE b2b_clients
        ADD COLUMN IF NOT EXISTS client_type VARCHAR(50) DEFAULT 'agente_calidad'
    `);
    console.log('  ✓ b2b_clients.client_type added');
};
