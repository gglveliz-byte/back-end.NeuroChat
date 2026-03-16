/**
 * Run ONLY B2B migrations (022-029) against a specific database.
 * 
 * Usage:
 *   $env:DATABASE_URL="postgresql://..."; node migrations/run_b2b.js
 */
require('dotenv').config();
const path = require('path');
const { query } = require('../src/config/database');

const B2B_MIGRATIONS = [
    '022_create_b2b_tables.js',
    '023_b2b_pull_config.js',
    '024_b2b_agent_limits.js',
    '025_add_unique_conversation_index.js',
    '026_add_price_basic.js',
    '027_b2b_agent_templates.js',
    '028_b2b_client_type.js',
    '029_create_b2b_web_tables.js',
    '030_b2b_voice_metrics.js',
];

async function runB2BMigrations() {
    try {
        console.log('\n🔗 Connected to database');
        console.log('📍 DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 50) + '...\n');

        // Create migrations table if not exists
        await query(`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ migrations table ready\n');

        // Check which are already done
        const result = await query('SELECT name FROM migrations');
        const executed = result.rows.map(r => r.name);

        for (const file of B2B_MIGRATIONS) {
            if (executed.includes(file)) {
                console.log(`⏭️  Already executed: ${file}`);
                continue;
            }

            console.log(`⏳ Running: ${file}`);
            try {
                const migration = require(path.join(__dirname, file));
                const fn = migration.up || migration.run || (typeof migration === 'function' ? migration : null);
                if (!fn) {
                    console.log(`  ⚠️  No up/run function in ${file}, skipping`);
                    await query('INSERT INTO migrations (name) VALUES ($1)', [file]);
                    continue;
                }
                await fn();
                await query('INSERT INTO migrations (name) VALUES ($1)', [file]);
                console.log(`✅ Done: ${file}\n`);
            } catch (err) {
                console.error(`❌ Error in ${file}:`, err.message);
                // Continue with next migration instead of stopping
                console.log('   Continuing with next migration...\n');
            }
        }

        console.log('\n✨ B2B migrations completed!\n');
        process.exit(0);

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

runB2BMigrations();
