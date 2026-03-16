/**
 * Migration 034: Create b2b_evaluation_history
 *
 * Stores a "fingerprint" of every completed evaluation tied to the audio_hash.
 * When an interaction is deleted and the same audio is re-uploaded,
 * the system can retrieve the previous evaluation (including human corrections)
 * and feed it to the AI as prior context — "memory" that survives deletion.
 */
const { pool } = require('../src/config/database');

async function up() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS b2b_evaluation_history (
                id SERIAL PRIMARY KEY,
                audio_hash VARCHAR(64) NOT NULL,
                b2b_area_id UUID NOT NULL,
                assigned_agent VARCHAR(255),
                agent_result JSONB,
                calificacion NUMERIC(5,2) DEFAULT 0,
                status VARCHAR(50),
                human_corrections JSONB DEFAULT '[]',
                reprocess_count INTEGER DEFAULT 0,
                source_interaction_id UUID,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Index for fast lookup by audio_hash + area
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_eval_history_hash_area
            ON b2b_evaluation_history(b2b_area_id, audio_hash)
        `);

        // Only keep the LATEST evaluation per audio_hash per area
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_history_unique_hash
            ON b2b_evaluation_history(b2b_area_id, audio_hash)
        `);

        console.log('Migration 034: Created b2b_evaluation_history table');

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
        await client.query('DROP TABLE IF EXISTS b2b_evaluation_history');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { up, down };
