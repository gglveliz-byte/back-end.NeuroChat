/**
 * B2B Web OAuth Service
 * 
 * Manages OAuth2 client_credentials tokens for external client APIs.
 * Tokens are cached in DB and auto-refreshed when expired.
 */

const axios = require('axios');
const { query } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');

/**
 * Get a valid access token for a B2B client.
 * Returns cached token if still valid, otherwise fetches a new one.
 * 
 * @param {string} b2bClientId
 * @returns {Promise<string|null>} access_token or null if not configured
 */
async function getAccessToken(b2bClientId) {
    const result = await query(
        'SELECT * FROM b2b_web_oauth_configs WHERE b2b_client_id = $1',
        [b2bClientId]
    );

    const config = result.rows[0];
    if (!config) return null;

    // Check if cached token is still valid (with 60s buffer)
    if (config.cached_token && config.token_expires_at) {
        const expiresAt = new Date(config.token_expires_at);
        const now = new Date();
        const bufferMs = 60 * 1000; // 60 seconds before expiry
        if (expiresAt.getTime() - bufferMs > now.getTime()) {
            return config.cached_token;
        }
    }

    // Fetch new token
    return await refreshToken(b2bClientId, config);
}

/**
 * Fetch a new token from the OAuth server and cache it.
 */
async function refreshToken(b2bClientId, config) {
    try {
        const clientId = config.client_id ? decrypt(config.client_id) : '';
        const clientSecret = config.client_secret ? decrypt(config.client_secret) : '';

        console.log(`[B2B Web OAuth] Attempting token refresh for client ${b2bClientId}`);
        console.log(`[B2B Web OAuth]   URL: ${config.token_url}`);
        console.log(`[B2B Web OAuth]   client_id: "${clientId}"`);
        console.log(`[B2B Web OAuth]   client_secret: "${clientSecret.substring(0, 3)}...${clientSecret.substring(clientSecret.length - 3)}" (length: ${clientSecret.length})`);
        console.log(`[B2B Web OAuth]   grant_type: ${config.grant_type || 'client_credentials'}`);

        const response = await axios.post(config.token_url, {
            grant_type: config.grant_type || 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        }, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
        });

        const { access_token, expires_in } = response.data;

        if (!access_token) {
            console.error(`[B2B Web OAuth] No access_token in response for client ${b2bClientId}`);
            return null;
        }

        // Calculate expiry time
        const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

        // Cache token in DB
        await query(
            `UPDATE b2b_web_oauth_configs 
       SET cached_token = $1, token_expires_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE b2b_client_id = $3`,
            [access_token, expiresAt.toISOString(), b2bClientId]
        );

        console.log(`[B2B Web OAuth] ✅ Token refreshed for client ${b2bClientId}, expires in ${expires_in}s`);
        return access_token;

    } catch (error) {
        console.error(`[B2B Web OAuth] ❌ Token refresh failed for client ${b2bClientId}:`);
        console.error(`[B2B Web OAuth]   Status: ${error.response?.status}`);
        console.error(`[B2B Web OAuth]   Response: ${JSON.stringify(error.response?.data)}`);
        console.error(`[B2B Web OAuth]   Message: ${error.message}`);
        return null;
    }
}

/**
 * Save or update OAuth config for a B2B client.
 * Encrypts client_id and client_secret before storing.
 */
async function saveOAuthConfig(b2bClientId, { token_url, client_id, client_secret, grant_type }) {
    const encryptedClientId = client_id ? encrypt(client_id) : null;
    const encryptedSecret = client_secret ? encrypt(client_secret) : null;

    const existing = await query(
        'SELECT id FROM b2b_web_oauth_configs WHERE b2b_client_id = $1',
        [b2bClientId]
    );

    if (existing.rows[0]) {
        // Update — preserve existing encrypted values if new ones are not provided
        const updates = [];
        const values = [];
        let idx = 1;

        if (token_url) { updates.push(`token_url = $${idx++}`); values.push(token_url); }
        if (client_id) { updates.push(`client_id = $${idx++}`); values.push(encryptedClientId); }
        if (client_secret && client_secret !== '***SET***') {
            updates.push(`client_secret = $${idx++}`);
            values.push(encryptedSecret);
        }
        if (grant_type) { updates.push(`grant_type = $${idx++}`); values.push(grant_type); }

        // Invalidate cached token on config change
        updates.push('cached_token = NULL');
        updates.push('token_expires_at = NULL');
        updates.push('updated_at = CURRENT_TIMESTAMP');

        if (updates.length > 2) { // more than just cache invalidation
            values.push(b2bClientId);
            await query(
                `UPDATE b2b_web_oauth_configs SET ${updates.join(', ')} WHERE b2b_client_id = $${idx}`,
                values
            );
        }

        return existing.rows[0].id;
    } else {
        // Insert
        const result = await query(
            `INSERT INTO b2b_web_oauth_configs (b2b_client_id, token_url, client_id, client_secret, grant_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
            [b2bClientId, token_url, encryptedClientId, encryptedSecret, grant_type || 'client_credentials']
        );
        return result.rows[0].id;
    }
}

/**
 * Get OAuth config (masked secrets) for display.
 */
async function getOAuthConfig(b2bClientId) {
    const result = await query(
        'SELECT id, token_url, client_id, grant_type, cached_token IS NOT NULL as has_token, token_expires_at, created_at, updated_at FROM b2b_web_oauth_configs WHERE b2b_client_id = $1',
        [b2bClientId]
    );
    const row = result.rows[0];
    if (!row) return null;

    // Decrypt client_id for display
    let decryptedClientId = '';
    try {
        if (row.client_id) decryptedClientId = decrypt(row.client_id);
    } catch (e) {
        decryptedClientId = '(error decrypting)';
    }

    return {
        id: row.id,
        token_url: row.token_url,
        client_id: decryptedClientId,
        grant_type: row.grant_type,
        has_token: row.has_token,
        token_expires_at: row.token_expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/**
 * Test OAuth connection — tries to get a token.
 */
async function testConnection(b2bClientId) {
    try {
        const token = await getAccessToken(b2bClientId);
        if (token) {
            return { success: true, message: `Token obtenido (${token.substring(0, 20)}...)`, token_preview: token.substring(0, 20) + '...' };
        }
        return { success: false, message: 'No se pudo obtener el token. Verifica las credenciales guardadas.' };
    } catch (error) {
        return { success: false, message: error.message || 'Error desconocido al probar conexión' };
    }
}

/**
 * Force a token refresh — invalidates cache and fetches a new token.
 * Used when an API call returns 401 (token was revoked server-side).
 */
async function forceRefreshToken(b2bClientId) {
    // Invalidate cached token
    await query(
        `UPDATE b2b_web_oauth_configs SET cached_token = NULL, token_expires_at = NULL WHERE b2b_client_id = $1`,
        [b2bClientId]
    );
    console.log(`[B2B Web OAuth] Force refresh: cache invalidated for client ${b2bClientId}`);
    return await getAccessToken(b2bClientId);
}

module.exports = {
    getAccessToken,
    refreshToken,
    forceRefreshToken,
    saveOAuthConfig,
    getOAuthConfig,
    testConnection,
};
