const { query } = require('../src/config/database');

const up = async () => {
  console.log('Running migration 013: Create products and orders tables...');

  // =====================================================
  // TABLA: products
  // =====================================================
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      price DECIMAL(10,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      category VARCHAR(100) DEFAULT 'General',
      stock INTEGER DEFAULT 0,
      media_urls JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('  ✅ Table products created');

  // Indexes para products
  await query(`CREATE INDEX IF NOT EXISTS idx_products_client_id ON products(client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_products_client_active ON products(client_id, is_active) WHERE is_active = true`);
  await query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(client_id, category)`);
  console.log('  ✅ Products indexes created');

  // =====================================================
  // TABLA: orders
  // =====================================================
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) DEFAULT 'USD',
      status VARCHAR(30) DEFAULT 'pending',
      shipping_info JSONB DEFAULT '{}'::jsonb,
      voucher_url VARCHAR(500),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('  ✅ Table orders created');

  // Indexes para orders
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders(client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_conversation_id ON orders(conversation_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(client_id, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(client_id, created_at DESC)`);
  console.log('  ✅ Orders indexes created');

  console.log('✅ Migration 013 completed');
};

module.exports = { up };
