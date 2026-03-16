const { query } = require('../src/config/database');

/**
 * Migration: Seed initial services
 * Creates the 5 default platform services with initial prices
 * Admin can later edit names, descriptions, and prices from the admin panel
 */

async function up() {
  console.log('🌱 Seeding initial services...');

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

  for (const service of services) {
    // Check if service already exists
    const existing = await query(
      'SELECT id FROM services WHERE code = $1',
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
      console.log(`  ✓ Created service: ${service.name} ($${service.price_monthly}/mes)`);
    } else {
      console.log(`  ⏭️  Service already exists: ${service.name}`);
    }
  }

  console.log('✅ Services seeded successfully!');
}

module.exports = { up };
