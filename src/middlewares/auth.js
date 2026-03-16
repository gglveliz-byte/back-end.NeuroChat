const { verifyAccessToken } = require('../utils/jwt');
const { query } = require('../config/database');

// Middleware de autenticación general
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Token no proporcionado',
        code: 'AUTH_TOKEN_MISSING'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Token inválido o expirado',
        code: 'AUTH_TOKEN_INVALID'
      });
    }

    // Verificar que el usuario existe
    let user;
    if (decoded.type === 'admin') {
      // Admin desde .env (no está en BD)
      if (decoded.sub === 'admin-env') {
        user = {
          id: 'admin-env',
          email: process.env.ADMIN_EMAIL,
          name: process.env.ADMIN_NAME || 'Admin',
          role: 'superadmin',
          is_active: true
        };
      } else {
        // Admin legacy desde BD
        const result = await query(
          'SELECT id, email, name, role, is_active FROM admins WHERE id = $1',
          [decoded.sub]
        );
        user = result.rows[0];
      }
    } else {
      const result = await query(
        'SELECT id, email, name, status, email_verified FROM clients WHERE id = $1',
        [decoded.sub]
      );
      user = result.rows[0];
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no encontrado',
        code: 'AUTH_USER_NOT_FOUND'
      });
    }

    // Verificar estado del usuario
    if (decoded.type === 'admin' && decoded.sub !== 'admin-env' && !user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Cuenta desactivada',
        code: 'AUTH_ACCOUNT_DISABLED'
      });
    }

    if (decoded.type === 'client' && user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Cuenta no activa',
        code: 'AUTH_ACCOUNT_INACTIVE'
      });
    }

    req.user = {
      ...decoded,
      ...user
    };

    next();
  } catch (error) {
    console.error('Error de autenticación:', error);
    return res.status(500).json({
      success: false,
      error: 'Error interno de autenticación',
      code: 'AUTH_INTERNAL_ERROR'
    });
  }
};

// Middleware solo para admins
const adminOnly = (req, res, next) => {
  if (req.user.type !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado. Solo administradores.',
      code: 'AUTH_ADMIN_ONLY'
    });
  }
  next();
};

// Middleware solo para clientes
const clientOnly = (req, res, next) => {
  if (req.user.type !== 'client') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado. Solo clientes.',
      code: 'AUTH_CLIENT_ONLY'
    });
  }
  next();
};

// Middleware para verificar email verificado
const emailVerified = (req, res, next) => {
  if (req.user.type === 'client' && !req.user.email_verified) {
    return res.status(403).json({
      success: false,
      error: 'Debes verificar tu email primero',
      code: 'AUTH_EMAIL_NOT_VERIFIED'
    });
  }
  next();
};

module.exports = {
  authenticate,
  adminOnly,
  clientOnly,
  emailVerified
};
