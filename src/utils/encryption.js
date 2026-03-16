const crypto = require('crypto');

// =====================================================
// AES-256-GCM Encryption para tokens sensibles en DB
// =====================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Obtener la clave de encriptación del entorno
 * Debe ser exactamente 32 bytes (256 bits)
 */
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn('⚠️  ENCRYPTION_KEY no configurada. Usando fallback inseguro.');
    // En desarrollo, generar una key determinista (NO usar en producción)
    return crypto.scryptSync('dev_fallback_key_change_me', 'salt', 32);
  }

  // Si es hex de 64 chars = 32 bytes
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, 'hex');
  }

  // Si es base64
  if (key.length === 44 && key.endsWith('=')) {
    return Buffer.from(key, 'base64');
  }

  // Si es string plano, derivar con scrypt
  return crypto.scryptSync(key, 'chatbot_saas_salt', 32);
}

/**
 * Encriptar un texto
 * @param {string} plaintext - Texto a encriptar
 * @returns {string} - Texto encriptado en formato: iv:authTag:ciphertext (hex)
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    // Formato: iv:authTag:ciphertext
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (error) {
    console.error('Error encriptando:', error.message);
    throw new Error('Error de encriptación');
  }
}

/**
 * Desencriptar un texto
 * @param {string} encryptedText - Texto en formato iv:authTag:ciphertext
 * @returns {string} - Texto desencriptado
 */
function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;

  // Si no tiene el formato esperado, asumir que no está encriptado
  if (!encryptedText.includes(':') || encryptedText.split(':').length !== 3) {
    return encryptedText;
  }

  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, ciphertext] = encryptedText.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    // Si falla la desencriptación, podría ser texto plano legacy
    console.warn('Posible texto plano (no encriptado):', error.message);
    return encryptedText;
  }
}

/**
 * Encriptar un objeto JSON (para config con tokens)
 * Solo encripta los valores que contienen "_token" o "_secret" en su key
 */
function encryptSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitivePatterns = ['token', 'secret', 'password', 'api_key', 'access_key'];
  const encrypted = { ...obj };

  for (const [key, value] of Object.entries(encrypted)) {
    if (typeof value === 'string' && value.length > 0) {
      const isSecret = sensitivePatterns.some(pattern =>
        key.toLowerCase().includes(pattern)
      );
      if (isSecret) {
        encrypted[key] = encrypt(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      encrypted[key] = encryptSensitiveFields(value);
    }
  }

  return encrypted;
}

/**
 * Desencriptar campos sensibles de un objeto
 */
function decryptSensitiveFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitivePatterns = ['token', 'secret', 'password', 'api_key', 'access_key'];
  const decrypted = { ...obj };

  for (const [key, value] of Object.entries(decrypted)) {
    if (typeof value === 'string' && value.includes(':')) {
      const isSecret = sensitivePatterns.some(pattern =>
        key.toLowerCase().includes(pattern)
      );
      if (isSecret) {
        decrypted[key] = decrypt(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      decrypted[key] = decryptSensitiveFields(value);
    }
  }

  return decrypted;
}

/**
 * Generar una ENCRYPTION_KEY segura (para documentación / setup)
 */
function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  encrypt,
  decrypt,
  encryptSensitiveFields,
  decryptSensitiveFields,
  generateEncryptionKey
};
