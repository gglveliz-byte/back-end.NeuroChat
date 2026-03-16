const { query } = require('../config/database');

const getServices = async (req, res) => {
    try {
        const result = await query('SELECT id, name, code, description, price_monthly, price_basic, icon, color, features_basic, features_pro FROM services WHERE is_active = true ORDER BY price_monthly ASC');
        res.json({
            success: true,
            data: { services: result.rows }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
};

module.exports = { getServices };
