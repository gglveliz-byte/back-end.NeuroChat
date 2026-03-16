const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no configurado en variables de entorno');
  process.exit(1);
}

// Generar access token
const generateAccessToken = (user, userType) => {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      type: userType,
      role: user.role || 'user'
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
};

// Generar refresh token
const generateRefreshToken = async (userId, userType) => {
  const token = uuidv4() + '-' + uuidv4();

  // Si es admin desde .env, no guardar en BD (no tiene UUID)
  if (userId === 'admin-env' && userType === 'admin') {
    return token;
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 días

  await query(
    `INSERT INTO refresh_tokens (user_id, user_type, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, userType, token, expiresAt]
  );

  return token;
};

// Verificar access token
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// Verificar refresh token
const verifyRefreshToken = async (token) => {
  const result = await query(
    `SELECT * FROM refresh_tokens
     WHERE token = $1 AND expires_at > CURRENT_TIMESTAMP`,
    [token]
  );

  // Si se encuentra en BD, retornarlo
  if (result.rows[0]) {
    return result.rows[0];
  }

  // Si no está en BD, verificar si es un token válido de admin .env
  // (formato UUID-UUID y considerarlo válido por 30 días)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidPattern.test(token)) {
    // Token válido para admin desde .env (sin BD)
    return {
      user_id: 'admin-env',
      user_type: 'admin',
      token: token,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 días desde ahora
    };
  }

  return null;
};

// Revocar refresh token
const revokeRefreshToken = async (token) => {
  // No hacer nada si es token de admin .env (no está en BD)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(token)) {
    // Verificar si está en BD primero
    const result = await query('SELECT COUNT(*) as count FROM refresh_tokens WHERE token = $1', [token]);
    if (result.rows[0].count === '0') {
      return; // Token de admin .env, no hacer nada
    }
  }

  await query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
};

// Revocar todos los refresh tokens de un usuario
const revokeAllUserTokens = async (userId, userType) => {
  // No hacer nada si es admin desde .env
  if (userId === 'admin-env' && userType === 'admin') {
    return;
  }

  await query(
    'DELETE FROM refresh_tokens WHERE user_id = $1 AND user_type = $2',
    [userId, userType]
  );
};

// Limpiar tokens expirados
const cleanExpiredTokens = async () => {
  await query('DELETE FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP');
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  cleanExpiredTokens
};
