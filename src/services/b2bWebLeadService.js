/**
 * B2B Web Lead Service
 * 
 * Handles lead submission to external CRM systems (e.g. TOM).
 * Uses OAuth2 tokens from b2bWebOAuthService.
 */

const axios = require('axios');
const { query } = require('../config/database');
const { getAccessToken, forceRefreshToken } = require('./b2bWebOAuthService');

/**
 * Submit a lead to the client's external CRM.
 * 
 * @param {string} b2bClientId
 * @param {string} conversationId
 * @param {object} leadData — customer, location, products, etc.
 * @returns {Promise<{success: boolean, external_id?: string, error?: string}>}
 */
async function submitLead(b2bClientId, conversationId, leadData, _retried = false) {
    try {
        // Get the lead_submit endpoint config
        const endpointResult = await query(
            "SELECT url, http_method, channel_id FROM b2b_web_api_endpoints WHERE b2b_client_id = $1 AND endpoint_type = 'lead_submit'",
            [b2bClientId]
        );

        if (!endpointResult.rows[0]) {
            return { success: false, error: 'Lead submission endpoint not configured' };
        }

        const { url, channel_id } = endpointResult.rows[0];

        // Get access token
        const token = await getAccessToken(b2bClientId);
        if (!token) {
            return { success: false, error: 'Unable to obtain access token' };
        }

        // Build lead payload in the required format
        const payload = buildLeadPayload(leadData, channel_id);

        // Submit lead
        console.log(`[B2B Web Lead] Lead request: POST ${url} — customer: ${payload.customer?.full_name}, phone: ${payload.customer?.phone}`);
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
            },
            timeout: 45000,
        });

        console.log(`[B2B Web Lead] Lead response (${response.status}):`, JSON.stringify(response.data).substring(0, 500));

        // Extract external ID from response (try multiple paths)
        const d = response.data?.data || response.data;
        const externalId = d?.lead?.person || d?.lead?._id || d?.lead?.id || d?.id || d?.lead_id || d?._id || null;

        // Update conversation with lead submission status
        await query(
            `UPDATE b2b_web_conversations 
       SET lead_submitted = true, lead_external_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
            [externalId, conversationId]
        );

        console.log(`[B2B Web Lead] Lead submitted for conversation ${conversationId}. External ID: ${externalId}`);

        return {
            success: true,
            external_id: externalId,
            response_status: response.status,
        };

    } catch (error) {
        // Retry once with fresh token on 401 Unauthorized
        if (!_retried && error.response?.status === 401) {
            console.warn(`[B2B Web Lead] Submit 401 — forcing token refresh and retrying...`);
            await forceRefreshToken(b2bClientId);
            return submitLead(b2bClientId, conversationId, leadData, true);
        }

        const errData = error.response?.data;
        const serverMessage = errData?.serverMessage || errData?.message || error.message;
        console.error(`[B2B Web Lead] Error submitting lead:`, errData || error.message);

        // ── Handle specific CRM errors with user-friendly messages ──
        // Lead duplicado (Xtrim: 24h cooldown per document)
        if (serverMessage && serverMessage.includes('24 horas')) {
            return {
                success: false,
                error: 'Este cliente ya tiene un lead registrado en las últimas 24 horas. No es necesario enviar otro, un asesor ya se pondrá en contacto.',
                error_code: 'LEAD_DUPLICATE_24H',
            };
        }

        // Document/identification already exists
        if (serverMessage && (serverMessage.includes('identificación') || serverMessage.includes('duplicad'))) {
            return {
                success: false,
                error: 'Ya existe un lead con esta identificación. Un asesor se comunicará pronto.',
                error_code: 'LEAD_DUPLICATE',
            };
        }

        return {
            success: false,
            error: serverMessage || 'Error al enviar los datos al sistema. Por favor intenta más tarde.',
        };
    }
}

/**
 * Build the lead payload in the format required by the client's CRM.
 * 
 * Based on the TOM/Xtrim format:
 * { channel, event_datetime, customer, location, products, terms_and_conditions, source }
 */
function buildLeadPayload(data, channelId) {
    const {
        customer_name = '',
        customer_first_name = '',
        customer_last_name = '',
        customer_document_type = 'cedula',
        customer_document_number = '',
        customer_phone = '',
        customer_email = '',
        location_lat = '',
        location_lng = '',
        location_city = '',
        location_address = '',
        products = [],
        page_url = '',
    } = data;

    return {
        channel: channelId || '',
        event_datetime: new Date().toISOString(),
        customer: {
            full_name: customer_name || `${customer_first_name} ${customer_last_name}`.trim(),
            first_name: customer_first_name || customer_name.split(' ')[0] || '',
            last_name: customer_last_name || customer_name.split(' ').slice(1).join(' ') || '',
            document_type: customer_document_type,
            document_number: customer_document_number,
            phone: customer_phone,
            email: customer_email,
        },
        location: {
            has_location: !!(location_lat && location_lng),
            lat: location_lat ? String(location_lat) : '',
            lng: location_lng ? String(location_lng) : '',
            city: location_city || '',
            raw_address: location_address || '',
            reference: '',
        },
        products: products.map(p => ({
            product_name: p.name || p.product_name || '',
            product_price: p.price || p.product_price || 0,
            product_code: p.code || p.product_code || '',
        })),
        terms_and_conditions: true,
        source: {
            utm_source: 'neurochat',
            utm_campaign: 'agente_web',
            utm_medium: 'widget_chat',
            referrer: page_url || '',
        },
    };
}

/**
 * Check coverage at a given lat/lng using the client's coverage API.
 * 
 * @param {string} b2bClientId
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{covered: boolean, raw_response?: any, error?: string}>}
 */
async function checkCoverage(b2bClientId, lat, lng, _retried = false) {
    try {
        // Get the coverage_check endpoint config
        const endpointResult = await query(
            "SELECT url, http_method FROM b2b_web_api_endpoints WHERE b2b_client_id = $1 AND endpoint_type = 'coverage_check'",
            [b2bClientId]
        );

        if (!endpointResult.rows[0]) {
            return { covered: false, error: 'Coverage check endpoint not configured' };
        }

        const { url } = endpointResult.rows[0];

        // Get access token
        const token = await getAccessToken(b2bClientId);
        if (!token) {
            return { covered: false, error: 'Unable to obtain access token' };
        }

        // Call coverage API
        console.log(`[B2B Web Lead] Coverage request: POST ${url} — lat: ${lat}, lng: ${lng}`);
        console.log(`[B2B Web Lead] Token preview: ${token.substring(0, 30)}... (length: ${token.length})`);
        console.log(`[B2B Web Lead] Body:`, JSON.stringify({ lat: Number(lat), lng: Number(lng) }));
        const startTime = Date.now();
        const response = await axios.post(url, { lat: Number(lat), lng: Number(lng) }, {
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json',
            },
            timeout: 45000,
        });

        console.log(`[B2B Web Lead] Coverage responded in ${Date.now() - startTime}ms (status: ${response.status}):`, JSON.stringify(response.data).substring(0, 500));

        // Determine coverage result from response
        const data = response.data;
        const innerData = data.data || {};
        const innerMessage = innerData.message || '';

        // Detect Xtrim infrastructure errors (Oracle DB down, etc.)
        const isXtrimInfraError = !!(
            innerMessage.includes('ORA-') ||
            innerMessage.includes('TNS:') ||
            innerMessage.includes('Error interno') ||
            (innerData.code === -1 && !innerMessage.includes('No existe cobertura'))
        );

        if (isXtrimInfraError) {
            console.warn(`[B2B Web Lead] Coverage API infrastructure error: ${innerMessage}`);
            return {
                covered: false,
                error: 'El sistema de cobertura del proveedor está temporalmente fuera de servicio. Por favor intenta de nuevo en unos minutos.',
                error_code: 'PROVIDER_INFRA_ERROR',
                coverage_details: { message: innerMessage },
            };
        }

        const covered = !!(
            data.covered ||
            data.has_coverage ||
            data.available ||
            data.result === true ||
            data.success === true ||
            data.cobertura === true ||
            // Xtrim specific: response=true just means API responded, code=0 means actual coverage
            (data.response === true && innerData.code === 0)
        );

        // Extract rich coverage details from nested response
        const coverageDetails = innerData.data || innerData || {};

        return {
            covered,
            raw_response: data,
            coverage_details: {
                city: coverageDetails.city || null,
                cityId: coverageDetails.cityId || null,
                province: coverageDetails.province || null,
                sector: coverageDetails.sector || null,
                sectorType: coverageDetails.sectorType || null,
                subSector: coverageDetails.subSector || null,
                nodes: coverageDetails.nodes || [],
                availableNaps: coverageDetails.nodes?.[0]?.availableNaps || null,
                message: data.message || coverageDetails.message || null,
                externalTransactionId: coverageDetails.externalTransactionId || null,
            },
        };

    } catch (error) {
        // Retry once with fresh token on 401 Unauthorized
        if (!_retried && error.response?.status === 401) {
            console.warn(`[B2B Web Lead] Coverage 401 — forcing token refresh and retrying...`);
            await forceRefreshToken(b2bClientId);
            return checkCoverage(b2bClientId, lat, lng, true);
        }
        console.error(`[B2B Web Lead] Coverage check error:`, error.response?.data || error.message);
        return {
            covered: false,
            error: error.response?.data?.message || error.message,
        };
    }
}

module.exports = {
    submitLead,
    buildLeadPayload,
    checkCoverage,
};
