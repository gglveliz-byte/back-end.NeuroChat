const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 012: Adding performance indexes...');

  const indexes = [
    // Deduplicación de mensajes por external_id
    `CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id) WHERE external_id IS NOT NULL`,

    // Búsqueda de conversaciones por contacto + servicio
    `CREATE INDEX IF NOT EXISTS idx_conversations_contact_service ON conversations(contact_id, client_service_id)`,

    // Límites de mensajes por fecha
    `CREATE INDEX IF NOT EXISTS idx_message_usage_service_date ON message_usage(client_service_id, date)`,

    // Límites de conversación por fecha
    `CREATE INDEX IF NOT EXISTS idx_conversation_usage_conv_date ON conversation_message_usage(conversation_id, date)`,

    // Mensajes por conversación (para historial)
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC)`,

    // Pagos pendientes por servicio
    `CREATE INDEX IF NOT EXISTS idx_payments_service_status ON payments(client_service_id, status) WHERE status = 'pending'`,

    // Client services por client_id y service_code
    `CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id)`,

    // Conversaciones última actividad
    `CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(client_service_id, last_message_at DESC)`,
  ];

  for (const sql of indexes) {
    try {
      await query(sql);
      const indexName = sql.match(/idx_\w+/)?.[0] || 'unknown';
      console.log(`  ✅ ${indexName}`);
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log(`  ⏭️  Index already exists, skipping`);
      } else {
        console.error(`  ❌ Error:`, error.message);
      }
    }
  }

  console.log('✅ Migration 012 completed');
}

module.exports = { up: run, run };
