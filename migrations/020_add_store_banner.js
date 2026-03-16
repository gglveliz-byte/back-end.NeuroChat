const { pool } = require('../src/config/database');

async function up() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE businesses
            ADD COLUMN IF NOT EXISTS banner_url       VARCHAR(500),
            ADD COLUMN IF NOT EXISTS store_description TEXT
        `);

        console.log('✅ Migration 020: banner_url y store_description agregados a businesses');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function down() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            ALTER TABLE businesses
            DROP COLUMN IF EXISTS banner_url,
            DROP COLUMN IF EXISTS store_description
        `);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { up, down };
