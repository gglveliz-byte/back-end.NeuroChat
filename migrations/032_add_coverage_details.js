/**
 * Migration 032: Add coverage_details JSONB to b2b_web_conversations
 * Stores the full API response when coverage is checked (city, province, sector, nodes, etc.)
 */
const { pool } = require('../src/config/database');

async function up() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Add coverage_details column
        await client.query(`
            ALTER TABLE b2b_web_conversations
            ADD COLUMN IF NOT EXISTS coverage_details JSONB DEFAULT NULL
        `);

        console.log('✅ Migration 032: Added coverage_details to b2b_web_conversations');

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function down() {
    const client = await pool.connect();
    try {
        await client.query('ALTER TABLE b2b_web_conversations DROP COLUMN IF EXISTS coverage_details');
    } finally {
        client.release();
    }
}

module.exports = { up, down };
