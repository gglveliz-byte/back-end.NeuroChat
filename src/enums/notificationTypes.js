// Tipos de destinatarios de notificaciones
const NotificationRecipientTypes = Object.freeze({
  CLIENT: 'client',
  ADMIN: 'admin',
  B2B: 'b2b',
});

// Tipos de notificaciones
const NotificationTypes = Object.freeze({
  PAYMENT_CONFIRMED: 'payment_confirmed',
  VOICE_ACTIVATED:'voice_activated',
  TRIAL_EXPIRING: 'trial_expiring',
  SUBSCRIPTION_EXPIRING: 'subscription_expiring',
  SUBSCRIPTION_EXPIRED: 'subscription_expired',
  SEND_DAILY_LIMIT_REACHED: 'send_daily_limit_reached',
  SEND_HUMAN_ATTENTION: 'send_human_attention'
});


module.exports = {
  NotificationRecipientTypes,
  NotificationTypes
};