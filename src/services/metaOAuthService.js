const axios = require('axios');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');

// =====================================================
// Meta OAuth Service
// Flujo completo de Facebook Login para conectar
// WhatsApp Business, Messenger e Instagram
// =====================================================

const GRAPH_API_VERSION = 'v20.0';
const GRAPH_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const FACEBOOK_OAUTH_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

// =====================================================
// CONFIGURACIÓN
// =====================================================

/**
 * Obtener App ID y App Secret de Meta desde system_config
 */
async function getAppCredentials() {
  const result = await query(`
    SELECT value FROM system_config WHERE key = 'meta_api_config'
  `);

  if (result.rows.length === 0) {
    throw new Error('Meta API no está configurada. Configura App ID y App Secret en el panel admin.');
  }

  const config = JSON.parse(result.rows[0].value);

  if (!config.meta_app_id || !config.meta_app_secret) {
    throw new Error('Meta App ID o App Secret no configurados');
  }

  return {
    appId: config.meta_app_id,
    appSecret: config.meta_app_secret,
    verifyToken: config.meta_verify_token
  };
}

// =====================================================
// PASO 1: Generar URL de autorización
// =====================================================

/**
 * Genera la URL de Facebook Login para iniciar el OAuth
 * @param {Object} params
 * @param {string} params.clientId - UUID del cliente en nuestra DB
 * @param {string} params.serviceCode - 'whatsapp', 'messenger', 'instagram'
 * @param {string} params.redirectUri - URL de callback (tu backend)
 * @returns {Object} { authUrl, state }
 */
async function generateAuthUrl({ clientId, serviceCode, redirectUri }) {
  const { appId } = await getAppCredentials();

  // Scopes según el servicio
  // business_management es NECESARIO cuando la página está bajo un Business Manager/Portfolio Comercial
  const scopesByService = {
    whatsapp: [
      'whatsapp_business_management',
      'whatsapp_business_messaging',
      'business_management'
    ],
    messenger: [
      'pages_messaging',
      'pages_show_list',
      'pages_manage_metadata',
      'business_management'
    ],
    instagram: [
      'instagram_basic',
      'instagram_manage_messages',
      'pages_messaging',
      'pages_show_list',
      'pages_manage_metadata',
      'business_management'
    ]
  };

  const scopes = scopesByService[serviceCode] || scopesByService.whatsapp;

  // State contiene info para identificar al cliente al callback
  // Encriptamos para que no se pueda manipular
  const stateData = JSON.stringify({
    clientId,
    serviceCode,
    timestamp: Date.now(),
    nonce: require('crypto').randomBytes(16).toString('hex')
  });
  const state = encrypt(stateData);

  // Guardar state en DB para validarlo después (CSRF protection)
  await query(`
    INSERT INTO system_config (key, value, description)
    VALUES ($1, $2, 'OAuth state temporal')
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
  `, [`oauth_state_${clientId}_${serviceCode}`, state]);

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state: state,
    scope: scopes.join(','),
    response_type: 'code',
    auth_type: 'rerequest', // Forzar re-solicitar permisos (evita usar permisos cacheados/declinados)
    // Para WhatsApp Embedded Signup
    ...(serviceCode === 'whatsapp' && {
      config_id: process.env.META_CONFIG_ID || '',
      override_default_response_type: true
    })
  });

  const authUrl = `${FACEBOOK_OAUTH_URL}?${params.toString()}`;

  return { authUrl, state };
}

// =====================================================
// PASO 2: Intercambiar code por token
// =====================================================

/**
 * Intercambia el authorization_code por un short-lived token
 * @param {string} code - Authorization code de Facebook
 * @param {string} redirectUri - Debe ser idéntico al usado en generateAuthUrl
 * @returns {Object} { accessToken, tokenType, expiresIn }
 */
async function exchangeCodeForToken(code, redirectUri) {
  const { appId, appSecret } = await getAppCredentials();

  try {
    const response = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code: code
      }
    });

    return {
      accessToken: response.data.access_token,
      tokenType: response.data.token_type,
      expiresIn: response.data.expires_in // En segundos (~3600 para short-lived)
    };
  } catch (error) {
    console.error('Error intercambiando code:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.error?.message || 'Error al intercambiar código de autorización'
    );
  }
}

// =====================================================
// PASO 3: Convertir a long-lived token
// =====================================================

/**
 * Intercambia un short-lived token por un long-lived token (~60 días)
 * @param {string} shortLivedToken
 * @returns {Object} { accessToken, tokenType, expiresIn }
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  const { appId, appSecret } = await getAppCredentials();

  try {
    const response = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken
      }
    });

    return {
      accessToken: response.data.access_token,
      tokenType: response.data.token_type,
      expiresIn: response.data.expires_in // ~5184000 (60 días)
    };
  } catch (error) {
    console.error('Error obteniendo long-lived token:', error.response?.data || error.message);
    throw new Error(
      error.response?.data?.error?.message || 'Error al obtener token de larga duración'
    );
  }
}

// =====================================================
// PASO 4: Obtener Page Access Token (para Messenger/IG)
// =====================================================

/**
 * Obtener Page Access Tokens (long-lived, no expiran)
 * @param {string} userAccessToken - Long-lived user token
 * @returns {Array} Lista de páginas con sus tokens
 */
async function getPageAccessTokens(userAccessToken) {
  try {
    console.log('📄 Fetching pages from /me/accounts...');
    console.log('📄 Using Graph API version:', GRAPH_API_VERSION);

    // Paso 1: Consulta SIMPLE sin campos nested (instagram_business_account puede filtrar resultados)
    const response = await axios.get(`${GRAPH_API_URL}/me/accounts`, {
      params: {
        access_token: userAccessToken,
        fields: 'id,name,access_token,category',
        limit: 100
      },
      timeout: 15000
    });

    console.log('📄 API response status:', response.status);
    console.log('📄 Raw response data:', JSON.stringify(response.data).substring(0, 500));

    let pages = response.data?.data || [];
    console.log(`📄 Pages found: ${pages.length}`);

    // Si /me/accounts devuelve vacío, intentar via Business Manager
    if (pages.length === 0) {
      console.log('📄 ⚠️ /me/accounts empty - trying via Business Manager...');
      try {
        // Obtener los Business Managers del usuario
        const bizRes = await axios.get(`${GRAPH_API_URL}/me/businesses`, {
          params: { access_token: userAccessToken, fields: 'id,name' },
          timeout: 15000
        });
        const businesses = bizRes.data?.data || [];
        console.log(`📄 Businesses found: ${businesses.length}`, businesses.map(b => ({ id: b.id, name: b.name })));

        for (const biz of businesses) {
          try {
            // Obtener páginas de cada Business Manager
            const bizPagesRes = await axios.get(`${GRAPH_API_URL}/${biz.id}/owned_pages`, {
              params: {
                access_token: userAccessToken,
                fields: 'id,name,access_token,category',
                limit: 100
              },
              timeout: 15000
            });
            const bizPages = bizPagesRes.data?.data || [];
            console.log(`📄 Business "${biz.name}" pages: ${bizPages.length}`, bizPages.map(p => ({ id: p.id, name: p.name })));
            pages = pages.concat(bizPages);
          } catch (bizPageErr) {
            console.error(`📄 Error fetching pages from business "${biz.name}":`, bizPageErr.response?.data?.error?.message || bizPageErr.message);
          }
        }

        if (pages.length > 0) {
          console.log(`📄 ✅ Found ${pages.length} pages via Business Manager!`);
        }
      } catch (bizErr) {
        console.error('📄 Error fetching businesses:', bizErr.response?.data?.error?.message || bizErr.message);
      }
    }

    if (pages.length === 0) {
      console.log('📄 ❌ ALL methods returned 0 pages - debugging permissions...');
      try {
        const permsRes = await axios.get(`${GRAPH_API_URL}/me/permissions`, {
          params: { access_token: userAccessToken },
          timeout: 10000
        });
        const perms = permsRes.data?.data || [];
        console.log('📄 Permissions:', perms.map(p => `${p.permission}=${p.status}`).join(', '));
      } catch (permErr) {
        console.error('📄 Permissions check failed:', permErr.response?.data || permErr.message);
      }
      try {
        const meRes = await axios.get(`${GRAPH_API_URL}/me`, {
          params: { access_token: userAccessToken, fields: 'id,name' },
          timeout: 10000
        });
        console.log('📄 Token user:', meRes.data);
      } catch (meErr) {
        console.error('📄 Token check failed:', meErr.response?.data || meErr.message);
      }
    }

    // Paso 2: Para las páginas encontradas, obtener info de Instagram Business
    if (pages.length > 0) {
      console.log('📄 Pages detail:', pages.map(p => ({ id: p.id, name: p.name })));
      for (let i = 0; i < pages.length; i++) {
        try {
          const igRes = await axios.get(`${GRAPH_API_URL}/${pages[i].id}`, {
            params: {
              access_token: userAccessToken,
              fields: 'instagram_business_account{id,username}'
            },
            timeout: 10000
          });
          pages[i].instagram_business_account = igRes.data?.instagram_business_account || null;
        } catch (igErr) {
          pages[i].instagram_business_account = null;
        }
      }
    }

    return pages.map(page => ({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
      category: page.category,
      instagramAccount: page.instagram_business_account || null
    }));
  } catch (error) {
    console.error('❌ Error obteniendo page tokens:', error.response?.status, error.response?.data || error.message);
    throw new Error(`Error al obtener páginas: ${error.response?.data?.error?.message || error.message}`);
  }
}

// =====================================================
// PASO 5: Obtener info de WhatsApp Business
// =====================================================

/**
 * Obtener WhatsApp Business Accounts del usuario
 * @param {string} userAccessToken
 * @returns {Array} Lista de WABA con phone numbers
 */
async function getWhatsAppBusinessAccounts(userAccessToken) {
  try {
    // Obtener businesses del usuario
    const businessResponse = await axios.get(`${GRAPH_API_URL}/me/businesses`, {
      params: {
        access_token: userAccessToken,
        fields: 'id,name'
      }
    });

    const accounts = [];

    for (const business of businessResponse.data.data) {
      try {
        // Obtener WhatsApp Business Accounts de cada negocio
        const wabaResponse = await axios.get(
          `${GRAPH_API_URL}/${business.id}/owned_whatsapp_business_accounts`,
          {
            params: {
              access_token: userAccessToken,
              fields: 'id,name,currency,timezone_id,message_template_namespace'
            }
          }
        );

        for (const waba of wabaResponse.data.data) {
          // Obtener números de teléfono del WABA
          const phonesResponse = await axios.get(
            `${GRAPH_API_URL}/${waba.id}/phone_numbers`,
            {
              params: {
                access_token: userAccessToken,
                fields: 'id,display_phone_number,verified_name,quality_rating,platform_type'
              }
            }
          );

          accounts.push({
            businessId: business.id,
            businessName: business.name,
            wabaId: waba.id,
            wabaName: waba.name,
            phoneNumbers: phonesResponse.data.data.map(phone => ({
              phoneNumberId: phone.id,
              displayPhone: phone.display_phone_number,
              verifiedName: phone.verified_name,
              qualityRating: phone.quality_rating
            }))
          });
        }
      } catch (wabaError) {
        // Este negocio no tiene WABA, continuar
        console.log(`Business ${business.name} sin WABA`);
      }
    }

    return accounts;
  } catch (error) {
    console.error('Error obteniendo WABA:', error.response?.data || error.message);
    throw new Error('Error al obtener cuentas de WhatsApp Business');
  }
}

// =====================================================
// PASO 6: Suscribir webhooks programáticamente
// =====================================================

/**
 * Suscribir la app a webhooks de una página (Messenger/Instagram)
 * @param {string} pageId
 * @param {string} pageAccessToken
 * @param {Array} subscribedFields - Campos a suscribir
 */
async function subscribePageWebhooks(pageId, pageAccessToken, subscribedFields = ['messages', 'messaging_postbacks']) {
  try {
    const response = await axios.post(
      `${GRAPH_API_URL}/${pageId}/subscribed_apps`,
      {
        subscribed_fields: subscribedFields
      },
      {
        headers: { 'Authorization': `Bearer ${pageAccessToken}` }
      }
    );

    return { success: response.data.success };
  } catch (error) {
    console.error('Error suscribiendo webhooks de página:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
}

/**
 * Suscribir webhooks de WhatsApp Business Account
 * @param {string} wabaId - WhatsApp Business Account ID
 * @param {string} accessToken
 */
async function subscribeWhatsAppWebhooks(wabaId, accessToken) {
  try {
    const response = await axios.post(
      `${GRAPH_API_URL}/${wabaId}/subscribed_apps`,
      {},
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    return { success: true, data: response.data };
  } catch (error) {
    console.error('Error suscribiendo webhooks WhatsApp:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
}

// =====================================================
// RENOVACIÓN DE TOKENS
// =====================================================

/**
 * Renovar un long-lived user token (antes de que expire)
 * Solo funciona si el token actual aún es válido
 * @param {string} currentToken - Token actual (long-lived)
 * @returns {Object} { accessToken, expiresIn } o null si falla
 */
async function refreshLongLivedToken(currentToken) {
  const { appId, appSecret } = await getAppCredentials();

  try {
    const response = await axios.get(`${GRAPH_API_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: currentToken
      }
    });

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in
    };
  } catch (error) {
    console.error('Error renovando token:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Verificar si un token es válido
 * @param {string} accessToken
 * @returns {Object} { valid, expiresAt, scopes, appId, userId }
 */
async function debugToken(accessToken) {
  const { appId, appSecret } = await getAppCredentials();

  try {
    const response = await axios.get(`${GRAPH_API_URL}/debug_token`, {
      params: {
        input_token: accessToken,
        access_token: `${appId}|${appSecret}`
      }
    });

    const data = response.data.data;

    return {
      valid: data.is_valid,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
      scopes: data.scopes || [],
      appId: data.app_id,
      userId: data.user_id,
      type: data.type, // 'USER', 'PAGE', etc.
      error: data.error || null
    };
  } catch (error) {
    console.error('Error verificando token:', error.response?.data || error.message);
    return { valid: false, error: error.message };
  }
}

// =====================================================
// GUARDAR CREDENCIALES DEL CLIENTE
// =====================================================

/**
 * Guardar las credenciales OAuth del cliente en la DB
 * @param {string} clientServiceId - UUID del client_service
 * @param {Object} credentials - Credenciales a guardar
 * @param {number} expiresInSeconds - Segundos hasta expiración del token
 */
async function saveClientCredentials(clientServiceId, credentials, expiresInSeconds) {
  const tokenExpiresAt = new Date();
  tokenExpiresAt.setSeconds(tokenExpiresAt.getSeconds() + (expiresInSeconds || 5184000)); // Default 60 días

  // Obtener config existente para no sobreescribir otros campos
  const existingResult = await query(
    'SELECT config FROM client_services WHERE id = $1',
    [clientServiceId]
  );
  const existingConfig = existingResult.rows[0]?.config || {};

  const mergedConfig = {
    ...existingConfig,
    platform_credentials: {
      ...(existingConfig.platform_credentials || {}),
      ...credentials
    },
    oauth_connected: true,
    oauth_connected_at: new Date().toISOString()
  };

  await query(`
    UPDATE client_services
    SET config = $1::jsonb,
        token_expires_at = $2,
        token_refreshed_at = CURRENT_TIMESTAMP,
        token_status = 'active',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $3
  `, [JSON.stringify(mergedConfig), tokenExpiresAt, clientServiceId]);

  return { success: true, tokenExpiresAt };
}

/**
 * Revocar/desconectar OAuth de un cliente
 */
async function revokeClientOAuth(clientServiceId) {
  const result = await query('SELECT config FROM client_services WHERE id = $1', [clientServiceId]);
  if (result.rows.length === 0) return { success: false, error: 'Servicio no encontrado' };

  const config = result.rows[0].config || {};
  const credentials = config.platform_credentials || {};

  // Intentar revocar permisos en Meta
  const token = credentials.user_access_token || credentials.page_access_token || credentials.whatsapp_access_token;
  if (token) {
    try {
      await axios.delete(`${GRAPH_API_URL}/me/permissions`, {
        params: { access_token: token }
      });
    } catch (error) {
      console.warn('Error revocando permisos en Meta:', error.message);
      // Continuar aunque falle la revocación en Meta
    }
  }

  // Limpiar credenciales en nuestra DB
  const cleanConfig = {
    ...config,
    platform_credentials: {},
    oauth_connected: false,
    oauth_disconnected_at: new Date().toISOString()
  };

  await query(`
    UPDATE client_services
    SET config = $1::jsonb,
        token_expires_at = NULL,
        token_refreshed_at = NULL,
        token_status = 'disconnected',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
  `, [JSON.stringify(cleanConfig), clientServiceId]);

  return { success: true };
}

// =====================================================
// VALIDAR STATE (CSRF Protection)
// =====================================================

/**
 * Validar el state del callback OAuth
 * @param {string} state - State recibido del callback
 * @returns {Object} { clientId, serviceCode } o null si inválido
 */
async function validateOAuthState(state) {
  try {
    const decryptedState = decrypt(state);
    const stateData = JSON.parse(decryptedState);

    // Verificar que el state no haya expirado (máx 30 minutos)
    const elapsed = Date.now() - stateData.timestamp;
    if (elapsed > 30 * 60 * 1000) {
      console.warn('OAuth state expirado');
      return null;
    }

    // Verificar que existe en DB
    const result = await query(`
      SELECT value FROM system_config
      WHERE key = $1
    `, [`oauth_state_${stateData.clientId}_${stateData.serviceCode}`]);

    if (result.rows.length === 0 || result.rows[0].value !== state) {
      console.warn('OAuth state no coincide con DB');
      return null;
    }

    // Limpiar state usado
    await query(`
      DELETE FROM system_config WHERE key = $1
    `, [`oauth_state_${stateData.clientId}_${stateData.serviceCode}`]);

    return stateData;
  } catch (error) {
    console.error('Error validando OAuth state:', error.message);
    return null;
  }
}

module.exports = {
  // Configuración
  getAppCredentials,

  // Flujo OAuth
  generateAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getPageAccessTokens,
  getWhatsAppBusinessAccounts,

  // Webhooks
  subscribePageWebhooks,
  subscribeWhatsAppWebhooks,

  // Tokens
  refreshLongLivedToken,
  debugToken,

  // Persistencia
  saveClientCredentials,
  revokeClientOAuth,
  validateOAuthState
};
