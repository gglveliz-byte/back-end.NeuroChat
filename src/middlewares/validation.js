const { body, param, query: queryParam, validationResult } = require('express-validator');

/**
 * Middleware que verifica errores de validación
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Datos de entrada inválidos',
      details: errors.array().map(e => ({
        field: e.path,
        message: e.msg
      }))
    });
  }
  next();
};

// =====================================================
// AUTH VALIDATORS
// =====================================================

const validateLogin = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 6 }).withMessage('Contraseña mínimo 6 caracteres'),
  body('userType').optional().isIn(['client', 'admin']).withMessage('Tipo de usuario inválido'),
  validate
];

const validateRegister = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password').isLength({ min: 8 }).withMessage('Contraseña mínimo 8 caracteres')
    .matches(/[A-Z]/).withMessage('Contraseña debe tener al menos una mayúscula')
    .matches(/[0-9]/).withMessage('Contraseña debe tener al menos un número'),
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre entre 2 y 100 caracteres'),
  body('phone').optional({ values: 'falsy' }).trim(),
  validate
];

const validateVerifyEmail = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('code').isLength({ min: 4, max: 10 }).withMessage('Código de verificación inválido'),
  validate
];

const validateForgotPassword = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  validate
];

const validateResetPassword = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('code').isLength({ min: 4, max: 10 }).withMessage('Código inválido'),
  body('newPassword').isLength({ min: 8 }).withMessage('Nueva contraseña mínimo 8 caracteres'),
  validate
];

// =====================================================
// CLIENT VALIDATORS
// =====================================================

const validateUpdateProfile = [
  body('name').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Nombre entre 2 y 100 caracteres'),
  body('phone').optional().trim(),
  validate
];

const validateUpdateBusiness = [
  body('name').trim().notEmpty().withMessage('El nombre es requerido'),
  body('industry').optional({ values: 'falsy' }).trim(),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
  body('country').optional({ values: 'falsy' }).trim(),
  body('address').optional({ values: 'falsy' }).trim(),
  body('website').optional({ values: 'falsy' }).trim().isURL().withMessage('URL inválida'),
  body('phone').optional({ values: 'falsy' }).trim(),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Email inválido'),
  validate
];

const validateChangePassword = [
  body('currentPassword').isLength({ min: 1 }).withMessage('Contraseña actual requerida'),
  body('newPassword').isLength({ min: 8 }).withMessage('Nueva contraseña mínimo 8 caracteres'),
  validate
];

// =====================================================
// WEBHOOK / MESSAGE VALIDATORS
// =====================================================

const validateIncomingMessage = [
  body('platform').isIn(['whatsapp', 'messenger', 'instagram', 'telegram', 'webchat'])
    .withMessage('Plataforma inválida'),
  body('businessId').isUUID().withMessage('businessId debe ser UUID válido'),
  body('contactId').notEmpty().trim().withMessage('contactId requerido'),
  body('message').isString().trim().isLength({ min: 1, max: 10000 })
    .withMessage('Mensaje entre 1 y 10000 caracteres'),
  body('messageType').optional().isIn(['text', 'image', 'audio', 'video', 'document'])
    .withMessage('Tipo de mensaje inválido'),
  validate
];

const validateWebChatMessage = [
  body('conversationId').isUUID().withMessage('conversationId debe ser UUID'),
  body('message').isString().trim().isLength({ min: 1, max: 5000 })
    .withMessage('Mensaje entre 1 y 5000 caracteres'),
  validate
];

// =====================================================
// ADMIN VALIDATORS
// =====================================================

const validateCreateClient = [
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nombre entre 2 y 100 caracteres'),
  body('password').isLength({ min: 8 }).withMessage('Contraseña mínimo 8 caracteres'),
  body('phone').optional().trim(),
  body('businessName').optional().trim().isLength({ max: 200 }),
  validate
];

const validateUpdateClient = [
  param('id').isUUID().withMessage('ID de cliente inválido'),
  body('name').optional().trim().isLength({ min: 2, max: 100 }),
  body('email').optional().isEmail().normalizeEmail(),
  body('status').optional().isIn(['active', 'inactive', 'suspended']),
  validate
];

const validatePaymentValidation = [
  param('id').isUUID().withMessage('ID de pago inválido'),
  body('approved').isBoolean().withMessage('approved debe ser booleano'),
  body('notes').optional().trim().isLength({ max: 500 }),
  validate
];

const validateBotConfig = [
  body('welcome_message').optional().trim().isLength({ max: 1000 }),
  body('away_message').optional().trim().isLength({ max: 1000 }),
  body('fallback_message').optional().trim().isLength({ max: 1000 }),
  body('personality').optional().isIn(['friendly', 'professional', 'casual', 'formal']),
  body('language').optional().isIn(['es', 'en', 'pt']),
  body('knowledge_base').optional().trim().isLength({ max: 15000 }),

  validate
];

// =====================================================
// SANITIZATION HELPER
// =====================================================

/**
 * Sanitizar un objeto eliminando campos peligrosos
 */
const sanitizeObject = (obj, allowedFields) => {
  const sanitized = {};
  for (const field of allowedFields) {
    if (obj[field] !== undefined) {
      sanitized[field] = typeof obj[field] === 'string' ? obj[field].trim() : obj[field];
    }
  }
  return sanitized;
};

module.exports = {
  validate,
  sanitizeObject,

  // Auth
  validateLogin,
  validateRegister,
  validateVerifyEmail,
  validateForgotPassword,
  validateResetPassword,

  // Client
  validateUpdateProfile,
  validateUpdateBusiness,
  validateChangePassword,

  // Webhook
  validateIncomingMessage,
  validateWebChatMessage,

  // Admin
  validateCreateClient,
  validateUpdateClient,
  validatePaymentValidation,
  validateBotConfig
};
