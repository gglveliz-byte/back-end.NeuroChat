const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * Middleware de autenticación para clientes B2B
 * Verifica token JWT con type === 'b2b_client'
 * Inyecta req.b2bClient con los datos del cliente
 */
const b2bAuthenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Token no proporcionado',
                code: 'B2B_TOKEN_MISSING'
            });
        }

        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({
                success: false,
                error: 'Token inválido o expirado',
                code: 'B2B_TOKEN_INVALID'
            });
        }

        // Verificar que sea un token de cliente B2B
        if (decoded.type !== 'b2b_client') {
            return res.status(403).json({
                success: false,
                error: 'Acceso denegado. Token no es de cliente B2B.',
                code: 'B2B_TOKEN_WRONG_TYPE'
            });
        }

        // Buscar el cliente B2B en la base de datos
        const result = await query(
            'SELECT id, company_name, contact_name, email, ai_provider, ai_model, status FROM b2b_clients WHERE id = $1',
            [decoded.sub]
        );

        if (!result.rows[0]) {
            return res.status(401).json({
                success: false,
                error: 'Cliente B2B no encontrado',
                code: 'B2B_CLIENT_NOT_FOUND'
            });
        }

        const client = result.rows[0];

        if (client.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'Cuenta B2B desactivada',
                code: 'B2B_ACCOUNT_INACTIVE'
            });
        }

        // Inyectar datos del cliente B2B en el request
        req.b2bClient = client;
        next();
    } catch (error) {
        console.error('Error de autenticación B2B:', error);
        return res.status(500).json({
            success: false,
            error: 'Error interno de autenticación',
            code: 'B2B_AUTH_ERROR'
        });
    }
};

/**
 * Genera un token JWT para un cliente B2B
 * @param {Object} client - Cliente B2B con id y email
 * @returns {string} Token JWT
 */
function generateB2BToken(client) {
    return jwt.sign(
        {
            sub: client.id,
            email: client.email,
            type: 'b2b_client'
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
}

module.exports = { b2bAuthenticate, generateB2BToken };
