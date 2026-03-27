const { query } = require('../config/database');
const metaOAuth = require('../services/metaOAuthService');
const birdService = require('../services/birdService');
const crypto = require('crypto');

// =====================================================
// OAuth Controller - Flujo de Facebook Login
// Permite a los clientes conectar sus cuentas de
// WhatsApp Business, Messenger e Instagram
// =====================================================

/**
 * POST /api/v1/oauth/meta/start
 * Genera la URL de autorización para iniciar Facebook Login
 * Body: { serviceCode: 'whatsapp' | 'messenger' | 'instagram' }
 */
const startOAuth = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.body;

    if (!['whatsapp', 'messenger', 'instagram'].includes(serviceCode)) {
      return res.status(400).json({
        success: false,
        error: 'serviceCode debe ser: whatsapp, messenger o instagram'
      });
    }

    // Verificar que el cliente tiene ese servicio activo o en trial
    const serviceResult = await query(`
      SELECT cs.id, cs.status, s.code
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2 AND cs.status IN ('active', 'trial')
    `, [clientId, serviceCode]);

    if (serviceResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'No tienes un servicio activo para esta plataforma'
      });
    }

    const redirectUri = `${process.env.BACKEND_URL}/api/v1/oauth/meta/callback`;

    const { authUrl, state } = await metaOAuth.generateAuthUrl({
      clientId,
      serviceCode,
      redirectUri
    });

    res.json({
      success: true,
      data: {
        authUrl,
        message: 'Redirige al usuario a authUrl para iniciar el flujo de Facebook Login'
      }
    });

  } catch (error) {
    console.error('Error iniciando OAuth:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al iniciar la conexión con Meta'
    });
  }
};

/**
 * GET /api/v1/oauth/meta/callback
 * Facebook redirige aquí después de que el usuario autoriza
 * Query params: code, state (o error, error_reason si deniega)
 */
const handleCallback = async (req, res) => {
  // OAuth callback from Facebook
  try {
    const { code, state, error: oauthError, error_reason } = req.query;

    // Si el usuario denegó los permisos
    if (oauthError) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/client/services/connect?status=denied&reason=${encodeURIComponent(error_reason || oauthError)}`
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=missing_params`
      );
    }

    // 1. Validar state (CSRF protection)
    const stateData = await metaOAuth.validateOAuthState(state);
    if (!stateData) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=invalid_state`
      );
    }

    const { clientId, serviceCode } = stateData;
    const redirectUri = `${process.env.BACKEND_URL}/api/v1/oauth/meta/callback`;

    // 2. Intercambiar code por short-lived token
    const shortLived = await metaOAuth.exchangeCodeForToken(code, redirectUri);

    // 3. Convertir a long-lived token
    const longLived = await metaOAuth.exchangeForLongLivedToken(shortLived.accessToken);

    // 4. Obtener client_service_id
    const csResult = await query(`
      SELECT cs.id FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=service_not_found`
      );
    }

    const clientServiceId = csResult.rows[0].id;
    let credentials = {};

    // 5. Según el servicio, obtener credenciales específicas
    if (serviceCode === 'whatsapp') {
      // Obtener WhatsApp Business Accounts
      const wabaAccounts = await metaOAuth.getWhatsAppBusinessAccounts(longLived.accessToken);

      if (wabaAccounts.length === 0) {
        return res.redirect(
          `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=no_waba_found`
        );
      }

      // Tomar el primer WABA y primer número (el cliente puede cambiar después)
      const firstWaba = wabaAccounts[0];
      const firstPhone = firstWaba.phoneNumbers[0];

      credentials = {
        user_access_token: longLived.accessToken,
        whatsapp_access_token: longLived.accessToken,
        waba_id: firstWaba.wabaId,
        waba_name: firstWaba.wabaName,
        business_id: firstWaba.businessId,
        phone_number_id: firstPhone?.phoneNumberId,
        display_phone: firstPhone?.displayPhone,
        verified_name: firstPhone?.verifiedName,
        available_accounts: wabaAccounts
      };

      // Suscribir webhooks automáticamente
      if (firstWaba.wabaId) {
        const subResult = await metaOAuth.subscribeWhatsAppWebhooks(
          firstWaba.wabaId, longLived.accessToken
        );
        credentials.webhook_subscribed = subResult.success;
      }

    } else if (serviceCode === 'messenger' || serviceCode === 'instagram') {
      // Obtener Pages y sus tokens
      const pages = await metaOAuth.getPageAccessTokens(longLived.accessToken);

      if (pages.length === 0) {
        const reason = serviceCode === 'instagram'
          ? 'no_pages_found_ig'
          : 'no_pages_found';
        return res.redirect(
          `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=${reason}`
        );
      }

      const firstPage = pages[0];

      // Para Instagram, verificar que la página tenga cuenta IG vinculada
      if (serviceCode === 'instagram') {
        const pageWithIG = pages.find(p => p.instagramAccount);
        if (!pageWithIG) {
          return res.redirect(
            `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=no_instagram_linked`
          );
        }
        // Usar la página que tiene Instagram vinculado
        // Solo guardar páginas con IG vinculado en available_pages
        const pagesWithIG = pages.filter(p => p.instagramAccount);
        credentials = {
          user_access_token: longLived.accessToken,
          page_access_token: pageWithIG.pageAccessToken,
          page_id: pageWithIG.pageId,
          page_name: pageWithIG.pageName,
          instagram_account_id: pageWithIG.instagramAccount.id,
          instagram_username: pageWithIG.instagramAccount.username,
          available_pages: pagesWithIG
        };
      } else {
        credentials = {
          user_access_token: longLived.accessToken,
          page_access_token: firstPage.pageAccessToken,
          page_id: firstPage.pageId,
          page_name: firstPage.pageName,
          available_pages: pages
        };
      }

      // Suscribir webhooks de la página correcta
      // Para Instagram, usar la página con IG vinculado (puede ser diferente a firstPage)
      const subscribePage = credentials.page_id
        ? { pageId: credentials.page_id, pageAccessToken: credentials.page_access_token }
        : firstPage;

      const fields = serviceCode === 'messenger'
        ? ['messages', 'messaging_postbacks', 'messaging_optins']
        : ['messages', 'messaging_postbacks'];

      const subResult = await metaOAuth.subscribePageWebhooks(
        subscribePage.pageId, subscribePage.pageAccessToken, fields
      );
      credentials.webhook_subscribed = subResult.success;
    }

    // 6. Guardar credenciales encriptadas en DB
    await metaOAuth.saveClientCredentials(
      clientServiceId,
      credentials,
      longLived.expiresIn
    );

    // 6b. Si el proveedor activo es Bird, registrar el canal en Bird workspace
    try {
      const providerRow = await query(`SELECT value FROM system_config WHERE key = 'messaging_provider'`);
      const activeProvider = providerRow.rows.length > 0 ? JSON.parse(providerRow.rows[0].value) : 'meta';

      if (activeProvider === 'bird') {
        const birdResult = await birdService.createChannelConnector(serviceCode, credentials);
        if (birdResult.success && birdResult.channelId) {
          // Guardar provider + bird_channel_id en config Y actualizar platform_account_id
          // El platform_account_id debe ser el bird_channel_id para que el webhook lookup funcione
          await query(`
            UPDATE client_services
            SET config = config || $1::jsonb,
                platform_account_id = $2
            WHERE id = $3
          `, [
            JSON.stringify({ provider: 'bird', bird_channel_id: birdResult.channelId }),
            birdResult.channelId,
            clientServiceId
          ]);
          console.log(`[Bird] Conector creado para ${serviceCode}: ${birdResult.channelId}`);
        } else {
          console.warn(`[Bird] No se pudo crear conector para ${serviceCode}:`, birdResult.error);
        }
      }
    } catch (birdErr) {
      // No bloquear el flujo si Bird falla — el servicio queda en modo meta como fallback
      console.error('[Bird] Error registrando canal (continuando con Meta):', birdErr.message);
    }

    // 7. Redirigir al frontend con éxito
    const successParams = new URLSearchParams({
      status: 'success',
      service: serviceCode,
      name: credentials.page_name || credentials.waba_name || credentials.verified_name || ''
    });

    // Cada plataforma va a su propia página con ?status=success
    const redirectUrl = `${process.env.FRONTEND_URL}/client/services/${serviceCode}?status=success&name=${encodeURIComponent(credentials.page_name || credentials.waba_name || credentials.verified_name || '')}`;

    res.redirect(redirectUrl);

  } catch (error) {
    console.error('❌ Error en callback OAuth:', error.message);
    console.error('❌ Stack:', error.stack);
    res.redirect(
      `${process.env.FRONTEND_URL}/client/services/connect?status=error&reason=${encodeURIComponent(error.message)}`
    );
  }
};

/**
 * GET /api/v1/oauth/meta/status
 * Verifica el estado de conexión OAuth del cliente
 * Query: ?serviceCode=whatsapp
 */
const getConnectionStatus = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.query;

    if (!serviceCode) {
      return res.status(400).json({ success: false, error: 'serviceCode requerido' });
    }

    const result = await query(`
      SELECT cs.id, cs.config, cs.token_expires_at, cs.token_status, cs.status,
             s.code as service_code, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: { connected: false, reason: 'Servicio no encontrado' }
      });
    }

    const service = result.rows[0];
    const config = service.config || {};
    const isConnected = config.oauth_connected === true;

    // Verificar validez del token si está conectado
    let tokenValid = false;
    if (isConnected && service.token_expires_at) {
      tokenValid = new Date(service.token_expires_at) > new Date();
    }

    // Info segura para el frontend (sin tokens)
    const safeCredentials = {};
    if (config.platform_credentials) {
      const creds = config.platform_credentials;
      safeCredentials.page_name = creds.page_name;
      safeCredentials.waba_name = creds.waba_name;
      safeCredentials.display_phone = creds.display_phone;
      safeCredentials.verified_name = creds.verified_name;
      safeCredentials.instagram_username = creds.instagram_username;
      safeCredentials.webhook_subscribed = creds.webhook_subscribed;
    }

    res.json({
      success: true,
      data: {
        connected: isConnected,
        tokenStatus: service.token_status || (isConnected ? 'active' : 'disconnected'),
        tokenValid,
        tokenExpiresAt: service.token_expires_at,
        serviceStatus: service.status,
        credentials: safeCredentials,
        connectedAt: config.oauth_connected_at
      }
    });

  } catch (error) {
    console.error('Error verificando estado OAuth:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

/**
 * POST /api/v1/oauth/meta/disconnect
 * Desconecta OAuth y revoca permisos en Meta
 * Body: { serviceCode: 'whatsapp' }
 */
const disconnectOAuth = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.body;

    const csResult = await query(`
      SELECT cs.id FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const result = await metaOAuth.revokeClientOAuth(csResult.rows[0].id);

    res.json({
      success: true,
      message: 'Cuenta desconectada exitosamente'
    });

  } catch (error) {
    console.error('Error desconectando OAuth:', error);
    res.status(500).json({ success: false, error: 'Error al desconectar' });
  }
};

/**
 * POST /api/v1/oauth/meta/select-account
 * Permite al cliente cambiar entre páginas/números disponibles
 * (Después de OAuth pueden tener múltiples)
 */
const selectAccount = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode, accountId } = req.body;

    const csResult = await query(`
      SELECT cs.id, cs.config FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const config = csResult.rows[0].config || {};
    const creds = config.platform_credentials || {};

    if (serviceCode === 'whatsapp') {
      // Buscar en available_accounts
      const accounts = creds.available_accounts || [];
      let found = null;
      let foundPhone = null;

      for (const account of accounts) {
        for (const phone of account.phoneNumbers || []) {
          if (phone.phoneNumberId === accountId) {
            found = account;
            foundPhone = phone;
            break;
          }
        }
        if (found) break;
      }

      if (!found) {
        return res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
      }

      creds.waba_id = found.wabaId;
      creds.waba_name = found.wabaName;
      creds.phone_number_id = foundPhone.phoneNumberId;
      creds.display_phone = foundPhone.displayPhone;
      creds.verified_name = foundPhone.verifiedName;

    } else {
      // Messenger/Instagram - buscar en available_pages
      const pages = creds.available_pages || [];
      const selectedPage = pages.find(p => p.pageId === accountId);

      if (!selectedPage) {
        return res.status(404).json({ success: false, error: 'Página no encontrada' });
      }

      creds.page_access_token = selectedPage.pageAccessToken;
      creds.page_id = selectedPage.pageId;
      creds.page_name = selectedPage.pageName;

      if (serviceCode === 'instagram') {
        if (!selectedPage.instagramAccount) {
          return res.status(400).json({ success: false, error: 'Esta página no tiene cuenta de Instagram Business vinculada. Vincula una cuenta de Instagram a tu página de Facebook primero.' });
        }
        creds.instagram_account_id = selectedPage.instagramAccount.id;
        creds.instagram_username = selectedPage.instagramAccount.username;
      }
    }

    config.platform_credentials = creds;

    await query(`
      UPDATE client_services SET config = $1::jsonb, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [JSON.stringify(config), csResult.rows[0].id]);

    res.json({
      success: true,
      message: 'Cuenta actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error seleccionando cuenta:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

/**
 * GET /api/v1/oauth/meta/available-accounts
 * Lista las cuentas disponibles tras OAuth
 */
const getAvailableAccounts = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.query;

    const csResult = await query(`
      SELECT cs.config FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.json({ success: true, data: { accounts: [] } });
    }

    const config = csResult.rows[0].config || {};
    const creds = config.platform_credentials || {};

    let accounts = [];
    if (serviceCode === 'whatsapp') {
      const wabaAccounts = creds.available_accounts || [];
      for (const account of wabaAccounts) {
        for (const phone of account.phoneNumbers || []) {
          accounts.push({
            id: phone.phoneNumberId,
            name: `${account.wabaName} - ${phone.displayPhone}`,
            verifiedName: phone.verifiedName,
            selected: phone.phoneNumberId === creds.phone_number_id
          });
        }
      }
    } else {
      const pages = creds.available_pages || [];
      // Para Instagram, solo mostrar páginas que tengan cuenta IG Business vinculada
      const filteredPages = serviceCode === 'instagram'
        ? pages.filter(p => p.instagramAccount)
        : pages;
      accounts = filteredPages.map(p => ({
        id: p.pageId,
        name: p.pageName,
        category: p.category,
        instagram: p.instagramAccount ? p.instagramAccount.username : null,
        selected: p.pageId === creds.page_id
      }));
    }

    res.json({ success: true, data: { accounts } });

  } catch (error) {
    console.error('Error obteniendo cuentas:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
};

/**
 * GET /api/v1/oauth/meta/debug-connection
 * Endpoint temporal para diagnosticar problemas de OAuth
 * Muestra el estado real de la conexión con Meta
 */
const debugConnection = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.query;

    if (!serviceCode) {
      return res.json({ error: 'Falta serviceCode en query params' });
    }

    const csResult = await query(`
      SELECT cs.id, cs.config, cs.token_expires_at, cs.token_status
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.json({ error: 'Servicio no encontrado para este cliente' });
    }

    const config = csResult.rows[0].config || {};
    const creds = config.platform_credentials || {};
    const token = creds.user_access_token;

    const debug = {
      hasConfig: !!config.oauth_connected,
      connectedAt: config.oauth_connected_at,
      tokenStatus: csResult.rows[0].token_status,
      tokenExpires: csResult.rows[0].token_expires_at,
      hasUserToken: !!token,
      tokenPreview: token ? `${token.substring(0, 15)}...` : null,
      pageName: creds.page_name,
      pageId: creds.page_id,
    };

    // Si tiene token, probar directamente contra la API de Facebook
    if (token) {
      const axios = require('axios');
      const GRAPH_API_URL = 'https://graph.facebook.com/v21.0';

      // Test 1: /me
      try {
        const meRes = await axios.get(`${GRAPH_API_URL}/me`, {
          params: { access_token: token, fields: 'id,name' },
          timeout: 10000
        });
        debug.meEndpoint = { success: true, data: meRes.data };
      } catch (e) {
        debug.meEndpoint = { success: false, error: e.response?.data || e.message };
      }

      // Test 2: /me/permissions
      try {
        const permsRes = await axios.get(`${GRAPH_API_URL}/me/permissions`, {
          params: { access_token: token },
          timeout: 10000
        });
        debug.permissions = permsRes.data?.data?.map(p => `${p.permission}=${p.status}`) || [];
      } catch (e) {
        debug.permissions = { error: e.response?.data || e.message };
      }

      // Test 3: /me/accounts
      try {
        const pagesRes = await axios.get(`${GRAPH_API_URL}/me/accounts`, {
          params: { access_token: token, fields: 'id,name,access_token,category' },
          timeout: 10000
        });
        debug.pagesEndpoint = {
          success: true,
          count: pagesRes.data?.data?.length || 0,
          pages: (pagesRes.data?.data || []).map(p => ({ id: p.id, name: p.name, category: p.category }))
        };
      } catch (e) {
        debug.pagesEndpoint = { success: false, error: e.response?.data || e.message };
      }
    }

    res.json({ success: true, debug });
  } catch (error) {
    res.json({ error: error.message, stack: error.stack });
  }
};

/**
 * POST /api/v1/oauth/meta/refresh-token
 * Renueva el long-lived token antes de que expire (~60 días)
 * Body: { serviceCode: 'whatsapp' }
 */
const refreshToken = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { serviceCode } = req.body;

    if (!serviceCode) {
      return res.status(400).json({ success: false, error: 'serviceCode requerido' });
    }

    const csResult = await query(`
      SELECT cs.id, cs.config FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [clientId, serviceCode]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const config = csResult.rows[0].config || {};
    const creds = config.platform_credentials || {};
    const currentToken = creds.whatsapp_access_token || creds.user_access_token || creds.page_access_token;

    if (!currentToken) {
      return res.status(400).json({ success: false, error: 'No hay token activo. Reconecta la cuenta.' });
    }

    const refreshed = await metaOAuth.refreshLongLivedToken(currentToken);
    if (!refreshed) {
      return res.status(400).json({
        success: false,
        error: 'No se pudo renovar el token. El token puede haber expirado. Reconecta la cuenta.'
      });
    }

    // Actualizar credenciales con el token renovado
    const updatedCredentials = {
      ...creds,
      whatsapp_access_token: refreshed.accessToken,
      user_access_token: refreshed.accessToken,
      ...(creds.page_access_token && { page_access_token: refreshed.accessToken })
    };

    await metaOAuth.saveClientCredentials(csResult.rows[0].id, updatedCredentials, refreshed.expiresIn);

    res.json({ success: true, message: 'Token renovado exitosamente. Válido por 60 días más.' });

  } catch (error) {
    console.error('Error renovando token OAuth:', error);
    res.status(500).json({ success: false, error: 'Error interno al renovar token' });
  }
};

/**
 * POST /api/v1/oauth/meta/data-deletion
 * Callback requerido por Meta cuando un usuario elimina la app desde Facebook.
 * Meta envía un signed_request como form-data (application/x-www-form-urlencoded).
 * Responde con { url, confirmation_code } según el protocolo de Meta.
 * Referencia: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 */
const metaDataDeletion = async (req, res) => {
  try {
    const { signed_request } = req.body;

    if (!signed_request) {
      return res.status(400).json({ error: 'signed_request is required' });
    }

    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      console.error('META_APP_SECRET no configurado — no se puede verificar data deletion');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    // signed_request = base64url(signature) + '.' + base64url(payload)
    const [encodedSig, encodedPayload] = signed_request.split('.');
    if (!encodedSig || !encodedPayload) {
      return res.status(400).json({ error: 'Invalid signed_request format' });
    }

    // Verificar firma HMAC-SHA256
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(encodedPayload)
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    if (expectedSig !== encodedSig) {
      console.warn('Meta data deletion: firma inválida recibida');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Decodificar payload
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8')
    );

    const facebookUserId = payload.user_id;
    const confirmationCode = crypto.randomBytes(12).toString('hex');

    console.log(`[Meta Data Deletion] Facebook user_id: ${facebookUserId} — code: ${confirmationCode}`);

    // Buscar client_services cuyo config tenga este facebook_user_id y marcar para eliminación
    // Los tokens de Meta se almacenan en client_services.config JSONB
    await query(`
      UPDATE client_services
      SET status = 'cancelled',
          config = config - 'access_token' - 'page_access_token'
      WHERE (config->>'facebook_user_id' = $1
          OR config->>'instagram_user_id' = $1)
        AND status NOT IN ('cancelled')
    `, [facebookUserId]);

    // URL donde el usuario puede consultar el estado de eliminación
    const statusUrl = `${process.env.FRONTEND_URL}/legal/data-deletion-status?code=${confirmationCode}`;

    return res.json({
      url: statusUrl,
      confirmation_code: confirmationCode
    });

  } catch (error) {
    console.error('Error en metaDataDeletion:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  startOAuth,
  handleCallback,
  getConnectionStatus,
  disconnectOAuth,
  selectAccount,
  getAvailableAccounts,
  debugConnection,
  refreshToken,
  metaDataDeletion
};
