const { query } = require('../src/config/database');

async function up() {
    console.log('🔄 Adding plan_type column to client_services...');

    try {
        // Check if column exists
        const check = await query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='client_services' AND column_name='plan_type'
    `);

        if (check.rows.length === 0) {
            await query(`
        ALTER TABLE client_services 
        ADD COLUMN plan_type VARCHAR(20) DEFAULT 'pro'
      `);

            // Update existing records to 'pro' just to be sure
            await query(`UPDATE client_services SET plan_type = 'pro' WHERE plan_type IS NULL`);

            console.log('✅ Column plan_type added successfully');
        } else {
            console.log('ℹ️ Column plan_type already exists');
        }
    } catch (error) {
        console.error('❌ Error adding plan_type column:', error);
        throw error;
    }
}

module.exports = { up };
