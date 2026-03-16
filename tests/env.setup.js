// Set all required env vars BEFORE any module is loaded by Jest
// This prevents process.exit(1) calls in app.js, jwt.js, etc.

process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters-long!!';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'admin123456';
process.env.ADMIN_NAME = 'Admin Test';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.PORT = '3099';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test-telegram-token';
process.env.META_APP_SECRET = 'test-meta-secret';
process.env.PAYPAL_CLIENT_ID = 'test-paypal-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-paypal-secret';
// Leave GROQ_API_KEY unset in tests — forces OpenAI provider for all plans

// Bloquear ADMIN_PASSWORD_HASH para que dotenv.config() no cargue el hash real del .env
// Esto fuerza el uso de ADMIN_PASSWORD (texto plano) en tests
process.env.ADMIN_PASSWORD_HASH = '';
