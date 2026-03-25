// Tipos de destinatarios de notificaciones
const NotificationRecipientTypes = Object.freeze({
  CLIENT: 'client',
  ADMIN: 'admin',
  B2B: 'b2b',
});

// Tipos de notificaciones
const NotificationTypes = Object.freeze({
  PAYMENT_CONFIRMED: 'payment_confirmed',
});


module.exports = {
  NotificationRecipientTypes,
  NotificationTypes
};