module.exports = {
  // Estados de cliente
  CLIENT_STATUS: {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    SUSPENDED: 'suspended'
  },

  // Estados de servicio
  SERVICE_STATUS: {
    TRIAL: 'trial',
    ACTIVE: 'active',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
    PENDING_PAYMENT: 'pending_payment'
  },

  // Estados de pago
  PAYMENT_STATUS: {
    PENDING: 'pending',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded'
  },

  // Métodos de pago
  PAYMENT_METHODS: {
    PAYPAL: 'paypal',
    TRANSFER: 'transfer'
  },

  // Tipos de usuario
  USER_TYPES: {
    ADMIN: 'admin',
    CLIENT: 'client'
  },

  // Plataformas
  PLATFORMS: {
    WHATSAPP: 'whatsapp',
    MESSENGER: 'messenger',
    INSTAGRAM: 'instagram',
    TELEGRAM: 'telegram',
    WEBCHAT: 'webchat'
  },

  // Tipos de mensaje
  MESSAGE_TYPES: {
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    VIDEO: 'video',
    DOCUMENT: 'document'
  },

  // Tipos de remitente
  SENDER_TYPES: {
    CONTACT: 'contact',
    BOT: 'bot',
    HUMAN: 'human'
  },

  // Estados de mensaje
  MESSAGE_STATUS: {
    PENDING: 'pending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed'
  },

  // Configuración de trial
  TRIAL: {
    DURATION_DAYS: 3,
    MAX_MESSAGES_PER_DAY: 100
  },

  // Configuración de límites para Plan Básico
  BASIC: {
    MAX_MESSAGES_PER_DAY: 500
  },

  // Configuración de límites para Plan Pro (alias PAID para compatibilidad)
  PRO: {
    MAX_MESSAGES_PER_DAY: 1000
  },

  // Mantener PAID como alias de PRO para compatibilidad
  PAID: {
    MAX_MESSAGES_PER_DAY: 1000
  },

  // Límites por conversación (anti-abuso de usuarios finales)
  CONVERSATION_LIMITS: {
    MAX_MESSAGES_PER_DAY: 50  // Máximo de mensajes que un usuario final puede enviar por día
  },

  // Estados de orden
  ORDER_STATUS: {
    PENDING: 'pending',
    PAID_VOUCHER: 'paid_voucher',
    APPROVED: 'approved',
    COMPLETED: 'completed',
    REJECTED: 'rejected'
  },

  // Configuración de JWT
  JWT: {
    ACCESS_TOKEN_EXPIRES: '8h',
    REFRESH_TOKEN_EXPIRES: '30d'
  },

  // ===================================================
  // PAY-AS-YOU-GO (PAYG) — Plan Ilimitado
  // ===================================================
  // Margen del 95%: cobramos 20x el costo real de OpenAI
  //   5% = costo operativo (OpenAI)
  //   95% = margen neto NeuroChat
  //
  // OpenAI gpt-4o-mini: $0.00015/1K input, $0.0006/1K output
  // Nosotros:           $0.003/1K  input, $0.012/1K  output
  //
  // Por mensaje promedio (1600 input + 300 output tokens):
  //   Costo OpenAI:       $0.00042
  //   Cobramos al cliente: $0.0084
  //   Ganancia:            $0.0080 (95% margen)
  //
  // Con $30 de recarga → ~3,571 mensajes incluidos
  PAYG: {
    // Lo que cobramos al cliente (20x = 95% margen)
    INPUT_PRICE_PER_1K:  0.003,  // $0.003 por 1K tokens de entrada
    OUTPUT_PRICE_PER_1K: 0.012,  // $0.012 por 1K tokens de salida

    // Costo real de OpenAI (para registro interno)
    OPENAI_INPUT_PER_1K:  0.00015,
    OPENAI_OUTPUT_PER_1K: 0.0006,

    // Alertas y comportamiento
    LOW_BALANCE_ALERT_USD:  5.00,   // Alerta cuando el saldo baje de $5
    ZERO_BALANCE_RESPONSE:  'Tu saldo de créditos se ha agotado. Recarga tu cuenta para continuar usando el asistente. 💳',
    MIN_RECHARGE_USD:       30.00,  // Recarga mínima $30 (superior al plan Pro)

    // ~mensajes incluidos por recarga de $30
    // ($30 / $0.0084 promedio ≈ 3,571 mensajes)
    APPROX_MSGS_PER_30USD: 3571,

    // plan_type identifier
    PLAN_TYPE: 'payg'
  }
};
