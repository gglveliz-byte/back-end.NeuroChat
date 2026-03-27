require('dotenv').config();

// ─── Self-Hosted AI Bootstrap (must load before any OpenAI imports) ───
require('./services/selfHostedBootstrap');

// ─── Global error handlers (prevent crashes from Redis/ioredis uncaught errors) ───
process.on('uncaughtException', (err) => {
  const msg = err.message || '';
  // Redis/Upstash limit errors — log and continue, don't crash
  if (msg.includes('max requests limit') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    console.error(`[Process] Caught Redis error (non-fatal): ${msg}`);
    return;
  }
  // For truly unexpected errors, log but don't crash in production
  console.error('[Process] Uncaught exception:', err);
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  // Silence all Redis/ioredis errors — non-fatal, queue falls back to memory
  if (msg.includes('max requests limit') || msg.includes('ECONNREFUSED') || msg.includes('Connection is closed') || msg.includes('ERR ')) {
    return; // silenced — Redis fallback already handled
  }
  console.error('[Process] Unhandled rejection:', reason);
});

// Validar variables de entorno críticas al arrancar
const requiredEnvVars = ['JWT_SECRET', 'DATABASE_URL', 'ADMIN_EMAIL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('FATAL: Variables de entorno requeridas no configuradas:', missingVars.join(', '));
  process.exit(1);
}

// Warnings para variables opcionales pero importantes
const warnEnvVars = ['OPENAI_API_KEY', 'META_APP_SECRET', 'TELEGRAM_BOT_TOKEN', 'PAYPAL_CLIENT_ID'];
warnEnvVars.forEach(v => {
  if (!process.env[v]) console.warn(`⚠️  ${v} no configurado - funcionalidad limitada`);
});

if (!process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  Usa ADMIN_PASSWORD_HASH en lugar de ADMIN_PASSWORD para mayor seguridad');
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');

// Rutas
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/client');
const serviceRoutes = require('./routes/service');
const webhookRoutes = require('./routes/webhook');
const oauthRoutes = require('./routes/oauth');
const productRoutes = require('./routes/product');
const voiceRoutes = require('./routes/voice');
const b2bRoutes = require('./routes/b2b');
const b2bWebRoutes = require('./routes/b2bWeb');

// Middlewares
const { apiLimiter } = require('./middlewares/rateLimiter');
const { captureRawBody } = require('./middlewares/webhookSignature');

// Controllers
const publicServiceController = require('./controllers/publicServiceController');
const widgetController = require('./controllers/widgetController');

// Inicializar servicio de email (muestra estado al iniciar)
require('./services/emailService');

// Verificar conexión con OpenAI al iniciar
const { checkConnection: checkOpenAI } = require('./services/openaiService');
checkOpenAI().then(result => {
  if (result.success) {
    console.log('✅ OpenAI conectado correctamente');
  } else {
    console.log('⚠️  OpenAI no configurado:', result.error);
  }
});

// Setup Telegram bot global al iniciar
const { setupGlobalBot } = require('./services/telegramService');
setupGlobalBot();

// Initialize B2B pipeline queue (non-blocking — fails gracefully if Redis unavailable)
const { initB2BQueue } = require('./queues/b2bQueue');
initB2BQueue()
  .then(() => console.log('✅ B2B Queue initialized'))
  .catch(err => console.warn('⚠️  B2B Queue not available:', err.message));

// Crear app
const app = express();
app.set('trust proxy', 1); // Render usa reverse proxy - necesario para rate-limit e IP detection
const server = http.createServer(app);

// Socket.io con CORS — en producción solo orígenes permitidos
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      const allowedOrigins = [process.env.FRONTEND_URL].filter(Boolean);
      if (process.env.NODE_ENV !== 'production') {
        allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');
        return callback(null, true);
      }

      // En producción: permitir orígenes configurados (el widget usa REST, no Socket.IO)
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('CORS no permitido para Socket.IO'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Inicializar WebSocket con autenticación y manejo de salas
const { initializeWebSocket } = require('./websocket/socketManager');
initializeWebSocket(io);

// Middleware global
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS selectivo: Webchat widget necesita permitir CUALQUIER origen
app.use((req, res, next) => {
  // Rutas públicas del widget + B2B auth: permitir cualquier origen
  if (
    req.path.startsWith('/api/v1/webhook/webchat') ||
    req.path.startsWith('/api/v1/widget') ||
    req.path.startsWith('/api/v1/b2b-web/widget') ||
    req.path.startsWith('/api/v1/b2b/auth') ||
    req.path.startsWith('/api/v1/b2b-web/admin') ||
    req.path.startsWith('/api/v1/b2b/')
  ) {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');

    // Manejar preflight OPTIONS
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    return next();
  }

  // Para el resto de rutas: permitir origenes configurados
  // Soporta FRONTEND_URL con múltiples dominios separados por coma
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }

      // Parse multiple allowed origins from FRONTEND_URL (comma or space separated)
      const allowedOrigins = (process.env.FRONTEND_URL || '')
        .split(/[,\s]+/)
        .map(u => u.trim())
        .filter(Boolean);

      if (allowedOrigins.some(ao => origin === ao || origin.endsWith(ao.replace(/^https?:\/\//, '')))) {
        callback(null, true);
      } else {
        // Allow but don't spam logs — only log once per unique origin
        if (!app._corsWarned) app._corsWarned = new Set();
        if (!app._corsWarned.has(origin)) {
          console.warn(`[CORS] New origin: ${origin} (configured: ${allowedOrigins.join(', ')})`);
          app._corsWarned.add(origin);
        }
        callback(null, true);
      }
    },
    credentials: true
  })(req, res, next);
});
// IMPORTANTE: verify callback captura el raw body ANTES del parse
// Necesario para verificar X-Hub-Signature-256 de Meta
app.use(express.json({ limit: '10mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting global (excluir admin y webhooks — tienen sus propios limitadores)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/v1/admin') || req.path.startsWith('/v1/webhook')) {
    return next();
  }
  apiLimiter(req, res, next);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Servir archivos estáticos de uploads
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Rutas API
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/client', clientRoutes);
app.use('/api/v1/service', serviceRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/oauth', oauthRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/store', require('./routes/store'));
app.use('/api/v1/voice', voiceRoutes);
app.use('/api/v1/b2b', b2bRoutes);
app.use('/api/v1/b2b-web', b2bWebRoutes);
const { authenticate: authMw, adminOnly: adminMw } = require('./middlewares/auth');
app.use('/api/v1/admin/ai-provider', authMw, adminMw, require('./routes/selfHostedAdmin'));

// Ruta para servicios disponibles (pública)
app.get('/api/v1/services', publicServiceController.getServices);

// Webhooks legacy (redirigir a nuevas rutas)
app.use('/api/v1/webhooks', webhookRoutes);

// Widget - obtener configuración
app.get('/api/v1/widget/config/:clientId', widgetController.getWidgetConfig);

// Manejo de errores 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada'
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Error interno del servidor'
  });
});

// Exportar io para usar en otros módulos
app.set('io', io);

// Inicializar CRON Jobs
const { initializeJobs, stopAllJobs } = require('./jobs');
initializeJobs();

// Iniciar servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🤖 ChatBot SaaS Backend                                  ║
║   ─────────────────────────────                            ║
║   Server running on port ${PORT}                             ║
║   Environment: ${process.env.NODE_ENV || 'development'}                           ║
║                                                            ║
║   Endpoints:                                               ║
║   • Health: http://localhost:${PORT}/health                   ║
║   • API: http://localhost:${PORT}/api/v1                      ║
║   • OAuth: http://localhost:${PORT}/api/v1/oauth              ║
║   • CRON Jobs: activos ✅                                   ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
const { closeQueue } = require('./queues/b2bQueue');

process.on('SIGTERM', () => {
  console.log('📛 SIGTERM recibido. Cerrando servidor...');
  stopAllJobs();
  closeQueue().catch(() => { });
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📛 SIGINT recibido. Cerrando servidor...');
  stopAllJobs();
  closeQueue().catch(() => { });
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

module.exports = { app, server, io };
