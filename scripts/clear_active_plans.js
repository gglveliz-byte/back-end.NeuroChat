
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function clearServices() {
    const client = await pool.connect();
    try {
        await client.query('SET search_path TO chatbot_saas');

        console.log('🗑️ Clearing data in schema: chatbot_saas');

        // Check tables in current search path
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'chatbot_saas'
        `);

        const tables = res.rows.map(r => r.table_name);
        console.log('Tables found:', tables);

        if (tables.includes('payments')) {
            await client.query('DELETE FROM payments');
            console.log('✅ Payments deleted.');
        }

        if (tables.includes('bot_configs')) {
            await client.query('DELETE FROM bot_configs');
            console.log('✅ Bot configs deleted.');
        }

        if (tables.includes('client_services')) {
            await client.query('DELETE FROM client_services');
            console.log('✅ Client services deleted.');
        }

        console.log('🎉 Cleanup complete!');
    } catch (err) {
        console.error('❌ Error:', err);
        console.error(err.stack);
    } finally {
        client.release();
        pool.end();
    }
}

clearServices();
