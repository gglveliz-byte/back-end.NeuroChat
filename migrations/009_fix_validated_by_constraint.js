const { query } = require('../src/config/database');

const up = async () => {
  console.log('Eliminando FK constraint de validated_by en payments...');

  // Cambiar validated_by de UUID REFERENCES admins(id) a VARCHAR (para soportar admin-env)
  await query(`
    ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS payments_validated_by_fkey
  `);

  // Cambiar tipo de columna a VARCHAR para aceptar 'admin-env'
  await query(`
    ALTER TABLE payments
    ALTER COLUMN validated_by TYPE VARCHAR(50) USING validated_by::VARCHAR
  `);

  console.log('✅ validated_by ahora acepta admin-env');
};

const down = async () => {
  await query(`
    ALTER TABLE payments
    ALTER COLUMN validated_by TYPE UUID USING validated_by::UUID
  `);
};

module.exports = { up, down };
