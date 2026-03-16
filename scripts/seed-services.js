require('dotenv').config();
const { query, pool } = require('../src/config/database');

/**
 * Script to seed initial services in the database
 * Run this script once to populate the services table
 */

async function seedServices() {
  console.log('\n🌱 Seeding services...\n');

  const services = [
    {
      name: 'WhatsApp',
      code: 'whatsapp',
      description: 'Automatiza tus conversaciones de WhatsApp con IA. Responde 24/7 a tus clientes.',
      price_monthly: 29.99,
      icon: '💬',
      color: '#25D366',
      is_active: true
    },
    {
      name: 'Facebook Messenger',
      code: 'messenger',
      description: 'Conecta con tus clientes en Facebook Messenger con respuestas automáticas inteligentes.',
      price_monthly: 24.99,
      icon: '📨',
      color: '#0084FF',
      is_active: true
    },
    {
      name: 'Instagram',
      code: 'instagram',
      description: 'Gestiona mensajes directos de Instagram con IA para engagement constante.',
      price_monthly: 24.99,
      icon: '📸',
      color: '#E4405F',
      is_active: true
    },
    {
      name: 'Telegram',
      code: 'telegram',
      description: 'Bot de Telegram con IA para atención automatizada en esta plataforma.',
      price_monthly: 19.99,
      icon: '✈️',
      color: '#0088CC',
      is_active: true
    },
    {
      name: 'WebChat',
      code: 'webchat',
      description: 'Widget de chat para tu sitio web. Fácil de integrar y personalizable.',
      price_monthly: 19.99,
      icon: '🌐',
      color: '#6366F1',
      is_active: true
    }
  ];

  try {
    for (const service of services) {
      // Check if service already exists
      const existing = await query(
        'SELECT id, name FROM services WHERE code = $1',
        [service.code]
      );

      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO services (name, code, description, price_monthly, icon, color, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            service.name,
            service.code,
            service.description,
            service.price_monthly,
            service.icon,
            service.color,
            service.is_active
          ]
        );
        console.log(`✅ Created: ${service.name} - $${service.price_monthly}/mes`);
      } else {
        console.log(`⏭️  Already exists: ${existing.rows[0].name}`);
      }
    }

    console.log('\n✨ Services seeded successfully!\n');
    console.log('📝 You can now manage these services from the admin panel at /admin/services');
    console.log('💰 The admin can edit prices, descriptions, and activate/deactivate services.\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error seeding services:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seedServices();
