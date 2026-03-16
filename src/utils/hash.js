const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

// Hashear contraseña
const hashPassword = async (password) => {
  return await bcrypt.hash(password, SALT_ROUNDS);
};

// Comparar contraseña
const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

// Generar código de verificación (6 dígitos)
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Generar referencia de pago única
const generatePaymentReference = () => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `PAY-${timestamp}-${random}`.toUpperCase();
};

module.exports = {
  hashPassword,
  comparePassword,
  generateVerificationCode,
  generatePaymentReference
};
