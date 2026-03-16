/**
 * Tests de integración con Supertest
 * Prueba los endpoints HTTP reales de la API
 */

// Mocks ANTES de cargar app.js (Jest los hoista al top del módulo)

// Mock rate limiters: evitar 429 durante tests
jest.mock('../src/middlewares/rateLimiter', () => {
  const passThrough = (req, res, next) => next();
  return {
    authLimiter: passThrough,
    apiLimiter: passThrough,
    webhookLimiter: passThrough,
    registerLimiter: passThrough
  };
});

jest.mock('../src/services/telegramService', () => ({
  setupGlobalBot: jest.fn().mockResolvedValue(undefined),
  sendMessage: jest.fn().mockResolvedValue(true),
  getGlobalBotToken: jest.fn().mockReturnValue('test-token'),
  globalBotInfo: null
}));

jest.mock('../src/services/openaiService', () => ({
  checkConnection: jest.fn().mockResolvedValue({ success: true }),
  generateResponse: jest.fn().mockResolvedValue({
    content: 'Respuesta de prueba',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai', model: 'gpt-4o-mini' }
  }),
  buildSystemPrompt: jest.fn().mockReturnValue('System prompt')
}));

jest.mock('../src/jobs', () => ({
  initializeJobs: jest.fn(),
  stopAllJobs: jest.fn()
}));

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  transaction: jest.fn()
}));

jest.mock('../src/services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true)
}));

const request = require('supertest');
const { query } = require('../src/config/database');

// Cargar la app DESPUÉS de configurar los mocks
let app;
beforeAll(() => {
  // Silenciar logs del servidor durante tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const appModule = require('../src/app');
  app = appModule.app;
});

afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
});

describe('API Integration Tests', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset default mock: query retorna vacío por defecto
    query.mockResolvedValue({ rows: [] });
  });

  // ============================================================
  // HEALTH CHECK
  // ============================================================
  describe('GET /health', () => {
    it('debe retornar 200 con status ok', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String)
      });
    });
  });

  // ============================================================
  // 404 NOT FOUND
  // ============================================================
  describe('Rutas no encontradas', () => {
    it('debe retornar 404 para ruta inexistente', async () => {
      const res = await request(app).get('/api/v1/ruta-inexistente');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: expect.stringContaining('no encontrada')
      });
    });
  });

  // ============================================================
  // AUTH - LOGIN
  // ============================================================
  describe('POST /api/v1/auth/login', () => {
    it('debe retornar 400 si faltan email y password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('debe retornar 400 si falta el password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'test@test.com' });

      expect(res.status).toBe(400);
    });

    it('debe loguear admin con credenciales correctas', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'admin123456',
          userType: 'admin'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe('admin-env');
      expect(res.body.data.tokens.accessToken).toBeTruthy();
    });

    it('debe rechazar admin con email incorrecto', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'wrong@test.com',
          password: 'admin123456',
          userType: 'admin'
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('debe retornar 401 para cliente inexistente', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // Cliente no encontrado

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'noexiste@test.com',
          password: 'password123'
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // ============================================================
  // AUTH - REGISTER
  // ============================================================
  describe('POST /api/v1/auth/register', () => {
    it('debe retornar 400 si faltan campos requeridos', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'test@test.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('debe retornar 400 si el password es muy corto', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'test@test.com',
          password: '123',
          name: 'Test User'
        });

      expect(res.status).toBe(400);
    });

    it('debe retornar 400 si el email ya existe', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'existing' }] }); // Email existe

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'existing@test.com',
          password: 'Password123',  // Mayúscula + número (requerido por validateRegister)
          name: 'Existing User'
        });

      expect(res.status).toBe(400);
      // El error puede venir del validator o del controller
      expect(res.body.success).toBe(false);
    });

    it('debe registrar nuevo cliente correctamente', async () => {
      const newId = '550e8400-e29b-41d4-a716-446655440099';
      query
        .mockResolvedValueOnce({ rows: [] }) // Email no existe
        .mockResolvedValueOnce({ rows: [{ id: newId, email: 'nuevo@test.com', name: 'Nuevo', phone: null }] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }) // INSERT email_verifications
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'nuevo@test.com',
          password: 'Password123',  // Mayúscula + número (requerido por validateRegister)
          name: 'Nuevo Usuario'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email_verified).toBe(false);
    });
  });

  // ============================================================
  // AUTH - VERIFY EMAIL
  // ============================================================
  describe('POST /api/v1/auth/verify-email', () => {
    it('debe retornar 400 si faltan email o código', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ email: 'test@test.com' });

      expect(res.status).toBe(400);
    });
  });

  // ============================================================
  // AUTH - FORGOT PASSWORD
  // ============================================================
  describe('POST /api/v1/auth/forgot-password', () => {
    it('debe retornar 400 si falta el email', async () => {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({});

      expect(res.status).toBe(400);
    });

    it('debe retornar 200 aunque el email no exista (seguridad)', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'noexiste@test.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ============================================================
  // AUTH - REFRESH TOKEN
  // ============================================================
  describe('POST /api/v1/auth/refresh', () => {
    it('debe retornar 400 si falta el refresh token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
    });

    it('debe retornar 401 para refresh token inválido', async () => {
      // Token no es UUID ni está en BD
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token-xyz' });

      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // RUTAS PROTEGIDAS - Sin autenticación deben dar 401
  // ============================================================
  describe('Rutas protegidas sin token', () => {
    it('GET /api/v1/auth/me debe retornar 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/client/dashboard debe retornar 401', async () => {
      const res = await request(app).get('/api/v1/client/dashboard');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/admin/clients debe retornar 401', async () => {
      const res = await request(app).get('/api/v1/admin/clients');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/service/whatsapp/conversations debe retornar 401', async () => {
      const res = await request(app).get('/api/v1/service/whatsapp/conversations');
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // RUTAS PROTEGIDAS - Con token de cliente, admin debe dar 403
  // ============================================================
  describe('Rutas de admin con token de cliente', () => {
    let clientToken;

    beforeAll(() => {
      // Generar token de cliente para las pruebas
      const { generateAccessToken } = require('../src/utils/jwt');
      clientToken = generateAccessToken(
        { id: '550e8400-e29b-41d4-a716-446655440000', email: 'client@test.com', name: 'Client', role: 'user' },
        'client'
      );
    });

    it('GET /api/v1/admin/clients con token de cliente debe retornar 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/clients')
        .set('Authorization', `Bearer ${clientToken}`);

      expect([401, 403]).toContain(res.status);
    });
  });

  // ============================================================
  // WEBHOOK - Verificación de Meta (GET)
  // ============================================================
  describe('GET /api/v1/webhook/whatsapp (Meta verification)', () => {
    it('debe rechazar verify_token incorrecto con status 4xx', async () => {
      const res = await request(app)
        .get('/api/v1/webhook/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': '12345'
        });

      // Puede ser 400 (bad request), 403 (forbidden) o 404 según implementación
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================================
  // SERVICIOS PÚBLICOS
  // ============================================================
  describe('GET /api/v1/services (público)', () => {
    it('debe retornar lista de servicios disponibles', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { id: '1', name: 'WhatsApp', code: 'whatsapp', price_monthly: 30 },
          { id: '2', name: 'Telegram', code: 'telegram', price_monthly: 20 }
        ]
      });

      const res = await request(app).get('/api/v1/services');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ============================================================
  // WIDGET CONFIG (público)
  // ============================================================
  describe('GET /api/v1/widget/config/:clientId', () => {
    it('debe retornar 404 si el cliente no existe', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // No config found

      const res = await request(app)
        .get('/api/v1/widget/config/nonexistent-id');

      expect([404, 400]).toContain(res.status);
    });
  });
});
