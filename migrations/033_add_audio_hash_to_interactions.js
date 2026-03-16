/**
 * Migration 033: Add audio_hash to b2b_interactions
 * SHA-256 fingerprint of the audio content (first 64KB sample).
 * Enables content-based deduplication independent of source_id / filename.
 */
const { pool } = require('../src/config/database');

async function up() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE b2b_interactions
            ADD COLUMN IF NOT EXISTS audio_hash VARCHAR(64) DEFAULT NULL
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_b2b_interactions_audio_hash
            ON b2b_interactions(b2b_area_id, audio_hash)
            WHERE audio_hash IS NOT NULL
        `);

        console.log('✅ Migration 033: Added audio_hash to b2b_interactions');

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
        await client.query('DROP INDEX IF EXISTS idx_b2b_interactions_audio_hash');
        await client.query('ALTER TABLE b2b_interactions DROP COLUMN IF EXISTS audio_hash');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { up, down };
