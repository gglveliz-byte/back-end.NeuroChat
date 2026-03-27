const fs = require('fs');
require('dotenv').config();
const { query } = require('./src/config/database');

async function check() {
    let output = '';
    try {
        const res = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'conversations' AND column_name = 'tags'
        `);
        output += 'COLUMN_INFO: ' + JSON.stringify(res.rows) + '\n';
        
        const migrations = await query(`
            SELECT name FROM migrations ORDER BY id DESC LIMIT 5
        `);
        output += 'LATEST_MIGRATIONS_NAMES: ' + JSON.stringify(migrations.rows.map(r => r.name)) + '\n';
    } catch (err) {
        output += 'CHECK ERROR: ' + err.message + '\n';
    } finally {
        fs.writeFileSync('db_check_result.txt', output);
        process.exit();
    }
}

check();
