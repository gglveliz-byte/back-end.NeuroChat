const crypto = require('crypto');
const { query } = require('../config/database');

// =====================================================
// Verificación de firma X-Hub-Signature-256 de Meta
// CRÍTICO: Sin esto, cualquiera puede inyectar mensajes falsos
// =====================================================

/**
 * Middleware para capturar el raw body ANTES de express.json()
 * Necesario porque la firma se calcula sobre el body crudo
 */
function captureRawBody(req, res, buf) {
  req.rawBody = buf;
}

/**
 * Obtener App Secret de Meta desde system_config
 */
async function getAppSecret() {
  try {
    const result = await query(
      "SELECT value FROM system_config WHERE key = 'meta_api_config'"
    );
    if (result.rows.length === 0) return null;

    const config = JSON.parse(result.rows[0].value);
    return config.meta_app_secret || null;
  } catch (error) {
    console.error('Error obteniendo App Secret:', error.message);
    return null;
  }
}

/**
 * Middleware: Verificar firma de webhooks de Meta
 * Meta envía X-Hub-Signature-256 = sha256=<hash>
 * donde <hash> = HMAC-SHA256(app_secret, raw_body)
 *
 * Uso en routes:
 *   router.post('/meta', verifyMetaSignature, handler)
 */
async function verifyMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  // Si no hay firma, podría ser un ambiente de desarrollo
  if (!signature) {
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_WEBHOOK_VERIFICATION === 'true') {
      console.warn('⚠️  Webhook sin firma - verificación desactivada en desarrollo');
      return next();
    }
    console.error('❌ Webhook rechazado: Sin firma X-Hub-Signature-256');
    return res.sendStatus(401);
  }

  // Obtener App Secrets (principal + Instagram si existe)
  const mainSecret = process.env.META_APP_SECRET || await getAppSecret();
  const igSecret = process.env.META_INSTAGRAM_APP_SECRET;

  const secrets = [mainSecret, igSecret].filter(Boolean);
  if (secrets.length === 0) {
    console.error('❌ META_APP_SECRET no configurado - rechazando webhook');
    return res.sendStatus(401);
  }

  // Verificar que tenemos el raw body
  if (!req.rawBody) {
    console.error('❌ rawBody no disponible - ¿se configuró el verify en express.json()?');
    return res.sendStatus(500);
  }

  // Intentar verificar con cada secret disponible (Meta App Secret o Instagram App Secret)
  let verified = false;
  for (const secret of secrets) {
    const expectedSignature = 'sha256=' +
      crypto.createHmac('sha256', secret)
        .update(req.rawBody)
        .digest('hex');

    try {
      const sigBuffer = Buffer.from(signature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

      if (sigBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        verified = true;
        break;
      }
    } catch (error) {
      // Intentar con el siguiente secret
    }
  }

  if (!verified) {
    console.error('❌ Webhook rechazado: Firma inválida (probados', secrets.length, 'secrets)');
    console.error('   Recibida:', signature.substring(0, 25) + '...');
    return res.sendStatus(401);
  }

  // Firma válida ✅
  next();
}

/**
 * Middleware: Verificar firma de webhooks de Telegram
 * Telegram usa un secret_token que se define al registrar el webhook
 */
function verifyTelegramSignature(req, res, next) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ TELEGRAM_WEBHOOK_SECRET no configurado en producción — rechazando webhook');
      return res.sendStatus(401);
    }
    console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET no configurado — verificación omitida (solo desarrollo)');
    return next();
  }

  if (!secret) {
    console.error('❌ Webhook Telegram rechazado: Sin secret token');
    return res.sendStatus(401);
  }

  // Comparación timing-safe para evitar timing attacks
  try {
    const secretBuf = Buffer.from(secret, 'utf8');
    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
      console.error('❌ Webhook Telegram rechazado: Secret inválido');
      return res.sendStatus(401);
    }
  } catch {
    console.error('❌ Webhook Telegram rechazado: Error en verificación');
    return res.sendStatus(401);
  }

  next();
}

module.exports = {
  captureRawBody,
  verifyMetaSignature,
  verifyTelegramSignature
};
