const rateLimit = require('express-rate-limit');

// Rate limiter para autenticación (más estricto)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // 50 intentos (Aumentado temporalmente para pruebas)
  message: {
    success: false,
    error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.',
    code: 'RATE_LIMIT_AUTH'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter general para API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requests por minuto
  message: {
    success: false,
    error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.',
    code: 'RATE_LIMIT_API'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter para webhooks (más permisivo)
const webhookLimiter = rateLimit({
  windowMs: 1000, // 1 segundo
  max: 50, // 50 por segundo
  message: {
    success: false,
    error: 'Demasiadas solicitudes de webhook.',
    code: 'RATE_LIMIT_WEBHOOK'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter para registro
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5, // 5 registros por hora por IP
  message: {
    success: false,
    error: 'Demasiados registros desde esta IP. Intenta más tarde.',
    code: 'RATE_LIMIT_REGISTER'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter para recuperación de contraseña (previene abuso de emails)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3, // 3 intentos por IP cada 15 min
  message: {
    success: false,
    error: 'Demasiados intentos de recuperación. Intenta de nuevo en 15 minutos.',
    code: 'RATE_LIMIT_FORGOT_PASSWORD'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  authLimiter,
  apiLimiter,
  webhookLimiter,
  registerLimiter,
  forgotPasswordLimiter
};
