const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 015: Making external_id unique for deduplication...');

  try {
    // 1. Eliminar mensajes duplicados (quedar con el de menor id por external_id)
    await query(`
      DELETE FROM messages
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM messages
        WHERE external_id IS NOT NULL
        GROUP BY external_id
      )
      AND external_id IS NOT NULL
    `);
    console.log('  ✅ Duplicates removed');
  } catch (e) {
    console.error('  ⚠️  Error removing duplicates:', e.message);
  }

  try {
    // 2. Eliminar el índice no-único existente
    await query(`DROP INDEX IF EXISTS idx_messages_external_id`);
    console.log('  ✅ Old non-unique index dropped');
  } catch (e) {
    console.error('  ⚠️  Error dropping old index:', e.message);
  }

  try {
    // 3. Crear índice ÚNICO parcial (solo donde external_id no es NULL)
    await query(`
      CREATE UNIQUE INDEX idx_messages_external_id
      ON messages(external_id)
      WHERE external_id IS NOT NULL
    `);
    console.log('  ✅ Unique partial index created on messages(external_id)');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  Unique index already exists');
    } else {
      console.error('  ❌ Error creating unique index:', e.message);
      throw e;
    }
  }

  console.log('✅ Migration 015 completed');
}

module.exports = { up: run, run };
