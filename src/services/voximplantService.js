/**
 * voximplantService.js
 * Gestión de la integración con Voximplant Platform API
 *
 * Funciones:
 * - getAccountInfo()         — verificar cuenta y saldo
 * - createApplication()      — crear aplicación NeuroChat en Voximplant
 * - uploadScenario()         — subir/actualizar el VoxEngine scenario
 * - bindNumberToApp()        — asociar número WhatsApp a la aplicación
 * - unbindNumber()           — desasociar número
 * - getApplicationInfo()     — obtener info de la aplicación
 *
 * Credenciales (en .env):
 *   VOXIMPLANT_ACCOUNT_ID   = 10342631
 *   VOXIMPLANT_API_KEY      = cdc979b2-1ef2-40fa-8463-ec6e0783126b
 *   VOXIMPLANT_API_ENDPOINT = api-node2.voximplant.com
 *   VOXIMPLANT_APP_NAME     = neurochat
 */

const axios = require('axios');

const BASE_URL = () =>
  `https://${process.env.VOXIMPLANT_API_ENDPOINT || 'api-node2.voximplant.com'}/platform_api`;

/**
 * Parámetros base de autenticación para todas las peticiones a la API.
 */
function authParams() {
  return {
    account_id: process.env.VOXIMPLANT_ACCOUNT_ID,
    api_key: process.env.VOXIMPLANT_API_KEY,
  };
}

/**
 * Helper: hace una petición GET a la Voximplant Platform API.
 */
async function apiGet(method, params = {}) {
  try {
    const response = await axios.get(`${BASE_URL()}/${method}`, {
      params: { ...authParams(), ...params },
      timeout: 15000,
    });

    if (response.data?.error) {
      throw new Error(`Voximplant API error [${method}]: ${JSON.stringify(response.data.error)}`);
    }

    return response.data;
  } catch (err) {
    if (err.response?.data) {
      throw new Error(`Voximplant ${method}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

/**
 * Helper: hace una petición POST a la Voximplant Platform API.
 */
async function apiPost(method, params = {}) {
  try {
    const response = await axios.post(`${BASE_URL()}/${method}`, null, {
      params: { ...authParams(), ...params },
      timeout: 15000,
    });

    if (response.data?.error) {
      throw new Error(`Voximplant API error [${method}]: ${JSON.stringify(response.data.error)}`);
    }

    return response.data;
  } catch (err) {
    if (err.response?.data) {
      throw new Error(`Voximplant ${method}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// =====================================================
// CUENTA
// =====================================================

/**
 * Verifica que las credenciales son válidas y retorna info de la cuenta.
 */
async function getAccountInfo() {
  return apiGet('GetAccountInfo');
}

// =====================================================
// APLICACIONES
// =====================================================

/**
 * Crea la aplicación NeuroChat en Voximplant (solo la primera vez).
 * Si ya existe, retorna la existente.
 */
async function createApplication(appName = null) {
  const name = appName || process.env.VOXIMPLANT_APP_NAME || 'neurochat';

  // Verificar si ya existe
  const existing = await apiGet('GetApplications', { application_name: name });
  if (existing.result?.length > 0) {
    console.log(`✅ [Voximplant] Aplicación "${name}" ya existe (ID: ${existing.result[0].application_id})`);
    return existing.result[0];
  }

  // Crear nueva
  const result = await apiPost('AddApplication', {
    application_name: name,
    secure_record_storage: true,
  });

  console.log(`✅ [Voximplant] Aplicación "${name}" creada (ID: ${result.application_id})`);
  return result;
}

/**
 * Obtiene información de la aplicación por nombre.
 */
async function getApplicationInfo(appName = null) {
  const name = appName || process.env.VOXIMPLANT_APP_NAME || 'neurochat';
  const result = await apiGet('GetApplications', { application_name: name });
  return result.result?.[0] || null;
}

// =====================================================
// ESCENARIOS (VOXENGINE)
// =====================================================

/**
 * Sube o actualiza el VoxEngine scenario en la aplicación.
 * @param {number} applicationId  ID de la aplicación Voximplant
 * @param {string} scenarioCode   Código JS del scenario
 * @param {string} scenarioName   Nombre del scenario
 */
async function uploadScenario(applicationId, scenarioCode, scenarioName = 'voice_ai') {
  // Verificar si ya existe
  const existing = await apiGet('GetScenarios', {
    application_id: applicationId,
    scenario_name: scenarioName,
  });

  if (existing.result?.length > 0) {
    // Actualizar existente
    const scenarioId = existing.result[0].scenario_id;
    await apiPost('SetScenarioInfo', {
      scenario_id: scenarioId,
      scenario_script: scenarioCode,
    });
    console.log(`✅ [Voximplant] Scenario "${scenarioName}" actualizado (ID: ${scenarioId})`);
    return { scenarioId, updated: true };
  }

  // Crear nuevo
  const result = await apiPost('AddScenario', {
    application_id: applicationId,
    scenario_name: scenarioName,
    scenario_script: scenarioCode,
  });

  console.log(`✅ [Voximplant] Scenario "${scenarioName}" creado (ID: ${result.scenario_id})`);
  return { scenarioId: result.scenario_id, updated: false };
}

// =====================================================
// NÚMEROS Y REGLAS
// =====================================================

/**
 * Crea una regla en la aplicación para enrutar llamadas al scenario.
 * @param {number} applicationId
 * @param {number} scenarioId
 * @param {string} ruleName
 * @param {string} customData  JSON string con config (backendUrl, etc.)
 */
async function createRule(applicationId, scenarioId, ruleName = 'incoming_voice', customData = '') {
  // Verificar si ya existe
  const existing = await apiGet('GetRules', {
    application_id: applicationId,
    rule_name: ruleName,
  });

  if (existing.result?.length > 0) {
    console.log(`✅ [Voximplant] Regla "${ruleName}" ya existe`);
    return existing.result[0];
  }

  const result = await apiPost('AddRule', {
    application_id: applicationId,
    rule_name: ruleName,
    rule_pattern: '.*',  // Enrutar todas las llamadas entrantes
    scenarios: JSON.stringify([scenarioId]),
    video_conference: false,
    custom_data: customData,
  });

  console.log(`✅ [Voximplant] Regla "${ruleName}" creada (ID: ${result.rule_id})`);
  return result;
}

/**
 * Obtiene todos los números/phones asociados a la cuenta.
 */
async function getPhoneNumbers() {
  return apiGet('GetPhoneNumbers');
}

// =====================================================
// SETUP INICIAL — Ejecutar una sola vez
// =====================================================

/**
 * Configura todo el stack de Voximplant:
 * 1. Verifica cuenta
 * 2. Crea aplicación (si no existe)
 * 3. Sube el scenario
 * 4. Crea regla de enrutamiento
 *
 * @param {string} scenarioCode  Código del VoxEngine scenario
 * @returns {Promise<{applicationId, scenarioId, ruleId}>}
 */
async function setupVoximplant(scenarioCode) {
  console.log('🔧 [Voximplant] Iniciando setup...');

  // 1. Verificar cuenta
  const account = await getAccountInfo();
  console.log(`✅ [Voximplant] Cuenta verificada: ${account.result?.account_name}`);

  // 2. Crear/obtener aplicación
  const app = await createApplication();
  const applicationId = app.application_id;

  // 3. Subir scenario
  const backendUrl = process.env.BACKEND_URL || 'https://your-backend.com';
  const fullScenarioCode = scenarioCode.replace('__BACKEND_URL__', backendUrl);
  const { scenarioId } = await uploadScenario(applicationId, fullScenarioCode);

  // 4. Crear regla
  const customData = JSON.stringify({
    backendUrl,
    webhookSecret: process.env.VOXIMPLANT_WEBHOOK_SECRET || 'neurochat-secret',
  });
  const rule = await createRule(applicationId, scenarioId, 'incoming_voice', customData);

  console.log('✅ [Voximplant] Setup completado:', { applicationId, scenarioId, ruleId: rule.rule_id });

  return { applicationId, scenarioId, ruleId: rule.rule_id };
}

module.exports = {
  getAccountInfo,
  createApplication,
  getApplicationInfo,
  uploadScenario,
  createRule,
  getPhoneNumbers,
  setupVoximplant,
};
