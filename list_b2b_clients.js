const { Client } = require('pg');
require('dotenv').config({ path: './.env' });

async function listClients() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        await client.query('SET search_path TO chatbot_saas, public');
        const res = await client.query('SELECT email, company_name, client_type FROM b2b_clients');
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error('Error connecting to DB:', err);
    } finally {
        await client.end();
    }
}

listClients();
