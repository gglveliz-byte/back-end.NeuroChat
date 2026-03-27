/**
 * Migration 036: Add audio_filename to b2b_interactions
 *
 * Stores the original uploaded filename so it can be displayed
 * in the interactions table even after source_id is replaced
 * by the temp file path during processing.
 */
const { pool } = require('../src/config/database');

async function up() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE b2b_interactions
            ADD COLUMN IF NOT EXISTS audio_filename TEXT
        `);

        console.log('Migration 036: Added audio_filename column to b2b_interactions');

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
        await client.query('BEGIN');
        await client.query(`ALTER TABLE b2b_interactions DROP COLUMN IF EXISTS audio_filename`);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { up, down };
