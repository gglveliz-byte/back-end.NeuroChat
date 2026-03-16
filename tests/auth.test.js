/**
 * Tests unitarios para AuthController
 * Mockea la base de datos y el servicio de email para aislar la lógica
 */

// Mocks ANTES de cualquier import (Jest los hoista al top)
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}));

jest.mock('../src/services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true)
}));

const { query } = require('../src/config/database');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../src/services/emailService');
const authController = require('../src/controllers/authController');
const bcrypt = require('bcryptjs');

// Helpers para crear req/res mock
const mockReq = (body = {}, user = null, params = {}) => ({ body, user, params });
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// UUID válido para pruebas de cliente
const TEST_CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('AuthController - Tests Unitarios', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // LOGIN
  // ============================================================
  describe('login()', () => {

    describe('Admin login (desde .env)', () => {
      it('debe loguear admin con credenciales correctas', async () => {
        const req = mockReq({
          email: 'admin@test.com',
          password: 'admin123456',
          userType: 'admin'
        });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            user: expect.objectContaining({
              id: 'admin-env',
              type: 'admin',
              role: 'superadmin'
            }),
            tokens: expect.objectContaining({
              accessToken: expect.any(String),
              refreshToken: expect.any(String)
            })
          })
        }));
        // Admin no requiere DB
        expect(query).not.toHaveBeenCalled();
      });

      it('debe rechazar admin con email incorrecto', async () => {
        const req = mockReq({
          email: 'wrong@test.com',
          password: 'admin123456',
          userType: 'admin'
        });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('inválidas')
        }));
      });

      it('debe rechazar admin con contraseña incorrecta', async () => {
        const req = mockReq({
          email: 'admin@test.com',
          password: 'wrongpassword',
          userType: 'admin'
        });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
      });
    });

    describe('Client login (desde BD)', () => {
      it('debe retornar 400 si faltan email o contraseña', async () => {
        const req = mockReq({ email: 'test@test.com' }); // sin password
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('requeridos')
        }));
      });

      it('debe retornar 401 si el cliente no existe', async () => {
        query.mockResolvedValueOnce({ rows: [] }); // Cliente no encontrado

        const req = mockReq({ email: 'noexiste@test.com', password: 'password123' });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
      });

      it('debe retornar 401 si la contraseña es incorrecta', async () => {
        const passwordHash = await bcrypt.hash('correctpassword', 10);
        query.mockResolvedValueOnce({
          rows: [{
            id: TEST_CLIENT_ID,
            email: 'client@test.com',
            password_hash: passwordHash,
            status: 'active',
            name: 'Test Client',
            role: 'client'
          }]
        });

        const req = mockReq({ email: 'client@test.com', password: 'wrongpassword' });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(401);
      });

      it('debe retornar 403 si la cuenta está inactiva', async () => {
        const passwordHash = await bcrypt.hash('password123', 10);
        query.mockResolvedValueOnce({
          rows: [{
            id: TEST_CLIENT_ID,
            email: 'client@test.com',
            password_hash: passwordHash,
            status: 'inactive',
            name: 'Test Client',
            role: 'client'
          }]
        });

        const req = mockReq({ email: 'client@test.com', password: 'password123' });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('no activa')
        }));
      });

      it('debe loguear cliente exitosamente con credenciales correctas', async () => {
        const passwordHash = await bcrypt.hash('password123', 10);

        query
          // 1. SELECT cliente por email
          .mockResolvedValueOnce({
            rows: [{
              id: TEST_CLIENT_ID,
              email: 'client@test.com',
              password_hash: passwordHash,
              status: 'active',
              name: 'Test Client',
              role: 'client',
              email_verified: true
            }]
          })
          // 2. UPDATE last_login
          .mockResolvedValueOnce({ rows: [] })
          // 3. INSERT refresh_token (en generateRefreshToken)
          .mockResolvedValueOnce({ rows: [] })
          // 4. SELECT business
          .mockResolvedValueOnce({ rows: [] })
          // 5. SELECT services
          .mockResolvedValueOnce({ rows: [] });

        const req = mockReq({ email: 'client@test.com', password: 'password123' });
        const res = mockRes();

        await authController.login(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            user: expect.objectContaining({
              email: 'client@test.com',
              type: 'client'
            }),
            tokens: expect.objectContaining({
              accessToken: expect.any(String),
              refreshToken: expect.any(String)
            })
          })
        }));
      });
    });
  });

  // ============================================================
  // REGISTER
  // ============================================================
  describe('register()', () => {
    it('debe retornar 400 si faltan campos requeridos', async () => {
      const req = mockReq({ email: 'test@test.com' }); // sin password y name
      const res = mockRes();

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('requeridos')
      }));
    });

    it('debe retornar 400 si la contraseña tiene menos de 8 caracteres', async () => {
      const req = mockReq({ email: 'test@test.com', password: 'abc', name: 'Test' });
      const res = mockRes();

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('8 caracteres')
      }));
    });

    it('debe retornar 400 si el email ya está registrado', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] }); // Email existe

      const req = mockReq({
        email: 'existing@test.com',
        password: 'password123',
        name: 'Test User'
      });
      const res = mockRes();

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('ya está registrado')
      }));
    });

    it('debe registrar nuevo cliente exitosamente', async () => {
      const newClientId = '550e8400-e29b-41d4-a716-446655440001';

      query
        // 1. CHECK email no existe
        .mockResolvedValueOnce({ rows: [] })
        // 2. INSERT client
        .mockResolvedValueOnce({
          rows: [{
            id: newClientId,
            email: 'new@test.com',
            name: 'New Client',
            phone: null
          }]
        })
        // 3. INSERT email_verifications
        .mockResolvedValueOnce({ rows: [] })
        // 4. INSERT refresh_token
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({
        email: 'new@test.com',
        password: 'password123',
        name: 'New Client'
      });
      const res = mockRes();

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          user: expect.objectContaining({
            email: 'new@test.com',
            email_verified: false,
            type: 'client'
          }),
          tokens: expect.objectContaining({
            accessToken: expect.any(String),
            refreshToken: expect.any(String)
          })
        })
      }));
      expect(sendVerificationEmail).toHaveBeenCalledWith(
        'new@test.com',
        'New Client',
        expect.any(String)
      );
    });

    it('debe convertir el email a lowercase al registrar', async () => {
      const newClientId = '550e8400-e29b-41d4-a716-446655440002';

      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: newClientId, email: 'user@test.com', name: 'User', phone: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({
        email: 'USER@TEST.COM',
        password: 'password123',
        name: 'User'
      });
      const res = mockRes();

      await authController.register(req, res);

      // Verificar que query fue llamado con email en lowercase
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM clients WHERE email'),
        ['user@test.com']
      );
    });
  });

  // ============================================================
  // VERIFY EMAIL
  // ============================================================
  describe('verifyEmail()', () => {
    it('debe retornar 400 si faltan email o código', async () => {
      const req = mockReq({ email: 'test@test.com' }); // sin code
      const res = mockRes();

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('debe retornar 400 si el código es inválido', async () => {
      query
        .mockResolvedValueOnce({ rows: [] }) // No code found
        .mockResolvedValueOnce({ rows: [] }); // Debug query

      const req = mockReq({ email: 'test@test.com', code: '999999' });
      const res = mockRes();

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('inválido')
      }));
    });

    it('debe retornar 400 si el código expiró', async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: 'verif-id', is_valid: false }]
      });

      const req = mockReq({ email: 'test@test.com', code: '123456' });
      const res = mockRes();

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('expirado')
      }));
    });

    it('debe verificar email exitosamente', async () => {
      query
        // 1. Buscar código válido
        .mockResolvedValueOnce({ rows: [{ id: 'verif-id', is_valid: true }] })
        // 2. Marcar código como usado
        .mockResolvedValueOnce({ rows: [] })
        // 3. UPDATE client verified
        .mockResolvedValueOnce({ rows: [] })
        // 4. SELECT client name para welcome email
        .mockResolvedValueOnce({ rows: [{ name: 'Test Client' }] });

      const req = mockReq({ email: 'test@test.com', code: '123456' });
      const res = mockRes();

      await authController.verifyEmail(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        message: expect.stringContaining('verificado')
      }));
    });
  });

  // ============================================================
  // LOGOUT
  // ============================================================
  describe('logout()', () => {
    it('debe hacer logout exitosamente con refresh token', async () => {
      // Token no-UUID → solo DELETE
      query.mockResolvedValueOnce({ rows: [] }); // DELETE

      const req = mockReq({ refreshToken: 'simple-non-uuid-token' });
      const res = mockRes();

      await authController.logout(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        message: expect.stringContaining('cerrada')
      }));
    });

    it('debe hacer logout exitosamente sin refresh token', async () => {
      const req = mockReq({});
      const res = mockRes();

      await authController.logout(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(query).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // FORGOT PASSWORD
  // ============================================================
  describe('forgotPassword()', () => {
    it('debe retornar 400 si falta el email', async () => {
      const req = mockReq({});
      const res = mockRes();

      await authController.forgotPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('debe retornar éxito aunque el email no exista (seguridad)', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // Usuario no encontrado

      const req = mockReq({ email: 'noexiste@test.com' });
      const res = mockRes();

      await authController.forgotPassword(req, res);

      // Siempre retorna éxito por seguridad
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('debe enviar email de reset para usuario válido', async () => {
      query
        // 1. SELECT user
        .mockResolvedValueOnce({ rows: [{ id: TEST_CLIENT_ID, email: 'user@test.com', name: 'User Test' }] })
        // 2. INSERT email_verifications
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ email: 'user@test.com' });
      const res = mockRes();

      await authController.forgotPassword(req, res);

      expect(sendPasswordResetEmail).toHaveBeenCalledWith(
        'user@test.com',
        'User Test',
        expect.any(String) // código generado
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  // ============================================================
  // RESET PASSWORD
  // ============================================================
  describe('resetPassword()', () => {
    it('debe retornar 400 si faltan campos requeridos', async () => {
      const req = mockReq({ email: 'test@test.com', code: '123456' }); // sin newPassword
      const res = mockRes();

      await authController.resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('debe retornar 400 si la nueva contraseña es muy corta', async () => {
      const req = mockReq({ email: 'test@test.com', code: '123456', newPassword: '123' });
      const res = mockRes();

      await authController.resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('8 caracteres')
      }));
    });

    it('debe retornar 400 si el código es inválido o expirado', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // Código no encontrado

      const req = mockReq({
        email: 'test@test.com',
        code: 'badcode',
        newPassword: 'newpassword123'
      });
      const res = mockRes();

      await authController.resetPassword(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('debe resetear contraseña exitosamente', async () => {
      query
        // 1. SELECT código válido
        .mockResolvedValueOnce({ rows: [{ id: 'verif-id' }] })
        // 2. UPDATE password
        .mockResolvedValueOnce({ rows: [] })
        // 3. UPDATE código como usado
        .mockResolvedValueOnce({ rows: [] })
        // 4. SELECT user id para revocar tokens
        .mockResolvedValueOnce({ rows: [{ id: TEST_CLIENT_ID }] })
        // 5. DELETE refresh_tokens (revokeAllUserTokens)
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({
        email: 'test@test.com',
        code: '123456',
        newPassword: 'newpassword123'
      });
      const res = mockRes();

      await authController.resetPassword(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        message: expect.stringContaining('actualizada')
      }));
    });
  });

  // ============================================================
  // GET ME
  // ============================================================
  describe('getMe()', () => {
    it('debe retornar datos del admin desde .env', async () => {
      const req = mockReq({}, { id: 'admin-env', type: 'admin' });
      const res = mockRes();

      await authController.getMe(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          id: 'admin-env',
          email: 'admin@test.com',
          type: 'admin'
        })
      }));
      expect(query).not.toHaveBeenCalled();
    });

    it('debe retornar datos del cliente desde BD', async () => {
      query
        // 1. SELECT client con join businesses
        .mockResolvedValueOnce({
          rows: [{
            id: TEST_CLIENT_ID,
            email: 'client@test.com',
            name: 'Client',
            phone: null,
            status: 'active',
            email_verified: true,
            created_at: new Date(),
            last_login: null,
            business_name: 'Mi Negocio'
          }]
        })
        // 2. SELECT services
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({}, { id: TEST_CLIENT_ID, type: 'client' });
      const res = mockRes();

      await authController.getMe(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          id: TEST_CLIENT_ID,
          email: 'client@test.com',
          type: 'client'
        })
      }));
    });
  });

  // ============================================================
  // RESEND VERIFICATION
  // ============================================================
  describe('resendVerification()', () => {
    it('debe retornar 400 si falta el email', async () => {
      const req = mockReq({});
      const res = mockRes();

      await authController.resendVerification(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('debe retornar 404 si el cliente no existe', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ email: 'noexiste@test.com' });
      const res = mockRes();

      await authController.resendVerification(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('debe retornar 400 si el email ya está verificado', async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: TEST_CLIENT_ID, name: 'Client', email_verified: true }]
      });

      const req = mockReq({ email: 'verified@test.com' });
      const res = mockRes();

      await authController.resendVerification(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('ya está verificado')
      }));
    });

    it('debe reenviar código de verificación exitosamente', async () => {
      query
        // 1. SELECT client
        .mockResolvedValueOnce({ rows: [{ id: TEST_CLIENT_ID, name: 'Client', email_verified: false }] })
        // 2. Invalidar códigos anteriores
        .mockResolvedValueOnce({ rows: [] })
        // 3. INSERT nuevo código
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ email: 'unverified@test.com' });
      const res = mockRes();

      await authController.resendVerification(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(sendVerificationEmail).toHaveBeenCalled();
    });
  });
});
