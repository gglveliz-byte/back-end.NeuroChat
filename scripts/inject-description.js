require('dotenv').config();
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

async function forceTelegramMessage() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const CLIENT_EMAIL = 'lveliz213@hotmail.com';
  const PLATFORM = 'telegram';
  const MESSAGE_CONTENT = '¡Hola! Este es un mensaje de prueba desde Telegram.';

  try {
    await client.connect();
    console.log('✅ Conexión a DB establecida');

    // Obtener el client_service_id de Telegram para este cliente
    const serviceRes = await client.query(`
      SELECT cs.id AS client_service_id
      FROM "chatbot_saas".client_services cs
      JOIN "chatbot_saas".clients c ON cs.client_id = c.id
      JOIN "chatbot_saas".services s ON cs.service_id = s.id
      WHERE c.email = $1 AND s.code ILIKE 'telegram'
      LIMIT 1
    `, [CLIENT_EMAIL]);

    if (serviceRes.rows.length === 0) {
      console.log('⚠️ No se encontró client_service de Telegram para este cliente.');
      return;
    }

    const CLIENT_SERVICE_ID = serviceRes.rows[0].client_service_id;
    console.log('📝 Client service de Telegram encontrado:', CLIENT_SERVICE_ID);

    // Crear conversación
    const conversationId = uuidv4();
    await client.query(`
      INSERT INTO "chatbot_saas".conversations (
        id, client_service_id, contact_id, platform, status, is_bot_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    `, [
      conversationId,
      CLIENT_SERVICE_ID,
      'test_user_telegram_001', // ID de prueba
      PLATFORM,
      'active',
      true
    ]);

    console.log(`🚀 Conversación creada con ID: ${conversationId}`);

    // Insertar mensaje inicial
    const messageId = uuidv4();
    await client.query(`
      INSERT INTO "chatbot_saas".messages (
        id, conversation_id, sender_type, content, message_type, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      messageId,
      conversationId,
      'bot',
      MESSAGE_CONTENT,
      'text',
      'sent'
    ]);

    console.log(`💬 Mensaje de prueba insertado con ID: ${messageId}`);

  } catch (err) {
    console.error('❌ Error creando mensaje de prueba:', err.message);
  } finally {
    await client.end();
  }
}

forceTelegramMessage();
