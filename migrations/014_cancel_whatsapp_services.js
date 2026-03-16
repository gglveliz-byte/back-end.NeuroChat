require('dotenv').config();
const { query } = require('../src/config/database');

async function up() {
  // Cancelar todos los client_services de WhatsApp existentes
  const result = await query(`
    UPDATE client_services cs
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    FROM services s
    WHERE cs.service_id = s.id
      AND s.code = 'whatsapp'
      AND cs.status NOT IN ('cancelled')
    RETURNING cs.id
  `);

  console.log(`✅ Cancelled ${result.rows.length} WhatsApp client_services`);
}

async function down() {
  // No revertir automáticamente — operación manual si se necesita restaurar
  console.log('⚠️  Down migration not implemented for safety. Restore manually if needed.');
}

module.exports = { up, down };
