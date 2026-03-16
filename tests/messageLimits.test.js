/**
 * Tests unitarios para messageLimitService
 * Verifica la lógica de límites diarios por servicio y por conversación
 */

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}));

const { query } = require('../src/config/database');
const messageLimitService = require('../src/services/messageLimitService');

const TEST_SERVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_CONV_ID    = '660e8400-e29b-41d4-a716-446655440000';
const TODAY = new Date().toISOString().split('T')[0];

describe('messageLimitService - Tests Unitarios', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // checkMessageLimit
  // ============================================================
  describe('checkMessageLimit()', () => {

    it('debe retornar allowed=false si el servicio no existe', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('no encontrado');
    });

    it('debe retornar allowed=false si el servicio está inactivo', async () => {
      query.mockResolvedValueOnce({
        rows: [{ status: 'cancelled', plan_type: 'pro' }]
      });

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('inactivo');
    });

    it('debe permitir mensajes en servicio trial bajo el límite (100/día)', async () => {
      query
        // 1. SELECT service info
        .mockResolvedValueOnce({ rows: [{ status: 'trial', plan_type: null }] })
        // 2. SELECT usage hoy
        .mockResolvedValueOnce({ rows: [{ message_count: 50 }] });

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(100);
      expect(result.current).toBe(50);
      expect(result.remaining).toBe(50);
    });

    it('debe bloquear mensajes en servicio trial que alcanzó el límite (100/día)', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'trial', plan_type: null }] })
        .mockResolvedValueOnce({ rows: [{ message_count: 100 }] }); // Límite alcanzado

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(100);
      expect(result.remaining).toBe(0);
    });

    it('debe usar límite de 500 para plan básico activo', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'active', plan_type: 'basic' }] })
        .mockResolvedValueOnce({ rows: [{ message_count: 250 }] });

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(500);
      expect(result.remaining).toBe(250);
    });

    it('debe usar límite de 2000 para plan pro activo', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'active', plan_type: 'pro' }] })
        .mockResolvedValueOnce({ rows: [{ message_count: 1999 }] });

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(2000);
      expect(result.remaining).toBe(1);
    });

    it('debe retornar 0 usage si no hay registros para hoy', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'trial', plan_type: null }] })
        .mockResolvedValueOnce({ rows: [] }); // Sin registros hoy

      const result = await messageLimitService.checkMessageLimit(TEST_SERVICE_ID);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
      expect(result.remaining).toBe(100);
    });
  });

  // ============================================================
  // incrementMessageCount
  // ============================================================
  describe('incrementMessageCount()', () => {

    it('debe crear registro nuevo e incrementar a 1 (primer mensaje)', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 1 }] });

      const result = await messageLimitService.incrementMessageCount(TEST_SERVICE_ID);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO message_usage'),
        [TEST_SERVICE_ID, TODAY]
      );
    });

    it('debe incrementar contador existente', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 42 }] });

      const result = await messageLimitService.incrementMessageCount(TEST_SERVICE_ID);

      expect(result.success).toBe(true);
      expect(result.count).toBe(42);
    });

    it('debe retornar error si la query falla', async () => {
      query.mockRejectedValueOnce(new Error('DB connection error'));

      const result = await messageLimitService.incrementMessageCount(TEST_SERVICE_ID);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ============================================================
  // checkConversationLimit
  // ============================================================
  describe('checkConversationLimit()', () => {

    it('debe permitir mensajes bajo el límite de conversación (50/día)', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 30 }] });

      const result = await messageLimitService.checkConversationLimit(TEST_CONV_ID);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(50);
      expect(result.current).toBe(30);
      expect(result.remaining).toBe(20);
    });

    it('debe bloquear cuando conversación alcanzó el límite (50/día)', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 50 }] });

      const result = await messageLimitService.checkConversationLimit(TEST_CONV_ID);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('debe permitir si no hay registros hoy (primer mensaje)', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.checkConversationLimit(TEST_CONV_ID);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
    });
  });

  // ============================================================
  // incrementConversationCount
  // ============================================================
  describe('incrementConversationCount()', () => {

    it('debe incrementar contador de conversación exitosamente', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 15 }] });

      const result = await messageLimitService.incrementConversationCount(TEST_CONV_ID);

      expect(result.success).toBe(true);
      expect(result.count).toBe(15);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO conversation_message_usage'),
        [TEST_CONV_ID, TODAY]
      );
    });
  });

  // ============================================================
  // atomicCheckAndIncrementService
  // ============================================================
  describe('atomicCheckAndIncrementService()', () => {

    it('debe retornar allowed=false si el servicio no existe', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.atomicCheckAndIncrementService(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      expect(result.error).toContain('no encontrado');
    });

    it('debe permitir y NO revertir cuando está bajo el límite', async () => {
      query
        // 1. SELECT service info
        .mockResolvedValueOnce({ rows: [{ status: 'active', plan_type: 'pro' }] })
        // 2. INSERT/UPDATE upsert → retorna count = 50 (bajo el límite de 2000)
        .mockResolvedValueOnce({ rows: [{ message_count: 50 }] });

      const result = await messageLimitService.atomicCheckAndIncrementService(TEST_SERVICE_ID);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(50);
      // Solo 2 queries, NO se llama la de revertir
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('debe bloquear y REVERTIR cuando supera el límite', async () => {
      query
        // 1. SELECT service info
        .mockResolvedValueOnce({ rows: [{ status: 'trial', plan_type: null }] })
        // 2. INSERT/UPDATE → retorna count = 101 (supera límite trial de 100)
        .mockResolvedValueOnce({ rows: [{ message_count: 101 }] })
        // 3. UPDATE revertir (message_count - 1)
        .mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.atomicCheckAndIncrementService(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      // Debe haberse llamado 3 queries (incluyendo el rollback)
      expect(query).toHaveBeenCalledTimes(3);
      expect(query).toHaveBeenLastCalledWith(
        expect.stringContaining('message_count = message_count - 1'),
        [TEST_SERVICE_ID, TODAY]
      );
    });

    it('debe bloquear servicio inactivo sin tocar la BD', async () => {
      query.mockResolvedValueOnce({ rows: [{ status: 'cancelled', plan_type: null }] });

      const result = await messageLimitService.atomicCheckAndIncrementService(TEST_SERVICE_ID);

      expect(result.allowed).toBe(false);
      expect(query).toHaveBeenCalledTimes(1); // Solo el SELECT de info
    });
  });

  // ============================================================
  // atomicCheckAndIncrementConversation
  // ============================================================
  describe('atomicCheckAndIncrementConversation()', () => {

    it('debe permitir y NO revertir cuando está bajo el límite (50/día)', async () => {
      query.mockResolvedValueOnce({ rows: [{ message_count: 25 }] });

      const result = await messageLimitService.atomicCheckAndIncrementConversation(TEST_CONV_ID);

      expect(result.allowed).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('debe bloquear y REVERTIR cuando supera el límite de conversación', async () => {
      query
        // 1. UPSERT → count = 51 (supera 50)
        .mockResolvedValueOnce({ rows: [{ message_count: 51 }] })
        // 2. Revertir
        .mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.atomicCheckAndIncrementConversation(TEST_CONV_ID);

      expect(result.allowed).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // getMessageUsage
  // ============================================================
  describe('getMessageUsage()', () => {

    it('debe retornar uso actual del servicio', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'active', plan_type: 'pro' }] })
        .mockResolvedValueOnce({ rows: [{ message_count: 150 }] });

      const result = await messageLimitService.getMessageUsage(TEST_SERVICE_ID);

      expect(result.current).toBe(150);
      expect(result.limit).toBe(2000);
      expect(result.remaining).toBe(1850);
    });
  });

  // ============================================================
  // getUsageHistory
  // ============================================================
  describe('getUsageHistory()', () => {

    it('debe retornar historial de los últimos 30 días', async () => {
      const mockHistory = [
        { date: '2026-02-20', message_count: 45 },
        { date: '2026-02-19', message_count: 120 },
        { date: '2026-02-18', message_count: 89 }
      ];
      query.mockResolvedValueOnce({ rows: mockHistory });

      const result = await messageLimitService.getUsageHistory(TEST_SERVICE_ID);

      expect(result).toHaveLength(3);
      expect(result[0].message_count).toBe(45);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('30 days'),
        [TEST_SERVICE_ID]
      );
    });

    it('debe retornar array vacío si no hay historial', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await messageLimitService.getUsageHistory(TEST_SERVICE_ID);

      expect(result).toEqual([]);
    });

    it('debe retornar array vacío si la query falla', async () => {
      query.mockRejectedValueOnce(new Error('DB error'));

      const result = await messageLimitService.getUsageHistory(TEST_SERVICE_ID);

      expect(result).toEqual([]);
    });
  });
});
