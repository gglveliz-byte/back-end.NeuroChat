// Quick debug script: shows what the evaluation template looks like for each agent
// Run: node tests/debug_template.js
require('dotenv').config();
const { query, pool } = require('../src/config/database');

async function debug() {
  try {
    const result = await query(`
      SELECT a.id, a.name, a.evaluation_template, ar.name as area_name
      FROM b2b_agents a
      JOIN b2b_areas ar ON a.b2b_area_id = ar.id
      WHERE a.evaluation_template IS NOT NULL AND a.is_active = true
      LIMIT 5
    `);

    for (const agent of result.rows) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Agent: ${agent.name} (Area: ${agent.area_name})`);
      console.log(`Template starts with: "${agent.evaluation_template.substring(0, 80)}..."`);
      console.log(`Template length: ${agent.evaluation_template.length} chars`);
      console.log(`Is JSON array: ${agent.evaluation_template.trim().startsWith('[')}`);

      // Try parsing
      const templateStr = agent.evaluation_template.trim();
      if (templateStr.startsWith('[')) {
        const rows = JSON.parse(templateStr);
        console.log(`JSON rows: ${rows.length}`);
        console.log(`First row keys: ${Object.keys(rows[0]).join(', ')}`);
        console.log(`First 3 rows:`, JSON.stringify(rows.slice(0, 3), null, 2));
      } else {
        const lines = templateStr.split('\n').filter(l => l.trim() && !l.trim().startsWith('==='));
        const headers = lines[0].split('|').map(h => h.trim());
        console.log(`Text headers: ${JSON.stringify(headers)}`);
        console.log(`Data lines: ${lines.length - 1}`);
        // Show first 3 data rows
        for (let i = 1; i < Math.min(4, lines.length); i++) {
          if (lines[i].includes('---')) { console.log(`  Row ${i}: --- separator ---`); continue; }
          const cols = lines[i].split('|').map(c => c.trim());
          console.log(`  Row ${i}: ${JSON.stringify(cols)}`);
        }
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    pool.end();
  }
}

debug();
