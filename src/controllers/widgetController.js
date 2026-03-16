const { query } = require('../config/database');

const getWidgetConfig = async (req, res) => {
    try {
        const { clientId } = req.params;

        const result = await query(`
      SELECT bc.welcome_message, bc.personality, bc.language,
             b.name as business_name, b.logo_url,
             cs.config
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      JOIN bot_configs bc ON cs.id = bc.client_service_id
      JOIN businesses b ON cs.client_id = b.client_id
      WHERE cs.client_id = $1 AND s.code = 'webchat' AND cs.status IN ('trial', 'active')
    `, [clientId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Widget no configurado o servicio inactivo'
            });
        }

        const config = result.rows[0];

        res.json({
            success: true,
            data: {
                welcomeMessage: config.welcome_message,
                businessName: config.business_name,
                logo: config.logo_url,
                personality: config.personality,
                language: config.language,
                widgetConfig: config.config || {}
            }
        });

    } catch (error) {
        console.error('Error en widget config:', error);
        res.status(500).json({
            success: false,
            error: 'Error interno'
        });
    }
};

module.exports = { getWidgetConfig };
