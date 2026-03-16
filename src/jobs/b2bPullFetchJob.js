const axios = require('axios');
const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');
const { addJob, isQueueReady } = require('../queues/b2bQueue');

/**
 * B2B PULL Fetcher — runs every 15 minutes.
 * Queries all B2B clients with pull_config enabled,
 * calls their API, maps fields, deduplicates, and enqueues pipeline jobs.
 */
async function runB2BPullFetch() {
  console.log('[B2B Pull] Starting pull cycle...');

  const result = await query(`
    SELECT id, company_name, pull_config, last_fetched_at
    FROM b2b_clients
    WHERE status = 'active'
      AND pull_config IS NOT NULL
      AND (pull_config->>'enabled')::boolean = true
  `);

  const clients = result.rows;
  console.log(`[B2B Pull] Found ${clients.length} client(s) with PULL config`);

  if (clients.length === 0) return { success: 0, errors: 0, interactions_created: 0 };

  const summary = { success: 0, errors: 0, interactions_created: 0 };

  for (const client of clients) {
    try {
      const created = await fetchClientData(client);
      summary.success++;
      summary.interactions_created += created;
    } catch (error) {
      console.error(`[B2B Pull] Error fetching client ${client.company_name} (${client.id}):`, error.message);
      summary.errors++;
    }
  }

  console.log(`[B2B Pull] Cycle complete — Success: ${summary.success}, Errors: ${summary.errors}, Created: ${summary.interactions_created}`);
  return summary;
}

/**
 * Fetch data for a single client, apply field mapping, deduplicate, and enqueue.
 */
async function fetchClientData(client) {
  const config = client.pull_config;
  const mapping = config.mapping || {};

  // Decrypt the API key
  const apiKey = config.api_key ? decrypt(config.api_key) : null;

  // Build request based on auth method
  const requestConfig = buildRequestConfig(config.api_url, apiKey, config.auth_method);

  // Fetch from client's API
  const response = await axios({ ...requestConfig, timeout: 30000 });

  // Navigate to the data array using data_path
  const rawData = extractByPath(response.data, mapping.data_path);
  if (!Array.isArray(rawData)) {
    console.warn(`[B2B Pull] Client ${client.id}: data_path "${mapping.data_path}" did not resolve to an array`);
    return 0;
  }

  // Verify default_area_id belongs to this client
  const areaCheck = await query(
    'SELECT id FROM b2b_areas WHERE id = $1 AND b2b_client_id = $2 AND is_active = true',
    [config.default_area_id, client.id]
  );
  if (!areaCheck.rows[0]) {
    throw new Error(`default_area_id ${config.default_area_id} not found or inactive`);
  }

  let created = 0;

  for (const item of rawData) {
    try {
      const sourceId = mapping.id_field ? String(item[mapping.id_field] ?? '') : null;

      // Deduplication
      if (sourceId) {
        const dup = await query(
          'SELECT id FROM b2b_interactions WHERE source_id = $1 AND b2b_area_id = $2',
          [sourceId, config.default_area_id]
        );
        if (dup.rows[0]) continue;
      }

      // Determine channel type
      const channel = mapping.type_field
        ? (item[mapping.type_field] === 'email' ? 'email' : 'call')
        : (mapping.default_type || 'call');

      if (channel === 'call') {
        created += await processCallItem(item, mapping, config.default_area_id, sourceId);
      } else {
        created += await processEmailItem(item, mapping, config.default_area_id, sourceId);
      }
    } catch (itemError) {
      console.error(`[B2B Pull] Error processing item for client ${client.id}:`, itemError.message);
    }
  }

  // Update last_fetched_at
  await query('UPDATE b2b_clients SET last_fetched_at = CURRENT_TIMESTAMP WHERE id = $1', [client.id]);

  console.log(`[B2B Pull] Client ${client.company_name}: created ${created}/${rawData.length} new interactions`);
  return created;
}

async function processCallItem(item, mapping, areaId, sourceId) {
  const audioUrl = mapping.audio_url_field ? item[mapping.audio_url_field] : null;
  if (!audioUrl) return 0;

  const result = await query(
    `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status)
     VALUES ($1, 'call', $2, '[pendiente transcripción]', 'recibido')
     RETURNING id`,
    [areaId, sourceId]
  );

  if (isQueueReady()) {
    await addJob('transcribe', { interactionId: result.rows[0].id, audioUrl });
  } else {
    await query("UPDATE b2b_interactions SET status = 'error_cola' WHERE id = $1", [result.rows[0].id]);
  }
  return 1;
}

async function processEmailItem(item, mapping, areaId, sourceId) {
  const body = mapping.email_body_field ? item[mapping.email_body_field] : null;
  if (!body) return 0;

  const from = mapping.email_from_field ? item[mapping.email_from_field] : null;
  const subject = mapping.email_subject_field ? item[mapping.email_subject_field] : null;
  const date = mapping.date_field ? item[mapping.date_field] : null;

  const rawText = [
    from ? `De: ${from}` : '',
    date ? `Fecha: ${date}` : '',
    subject ? `Asunto: ${subject}` : '',
    '',
    body
  ].filter(Boolean).join('\n');

  const result = await query(
    `INSERT INTO b2b_interactions (b2b_area_id, channel, source_id, raw_text, status)
     VALUES ($1, 'email', $2, $3, 'recibido')
     RETURNING id`,
    [areaId, sourceId, rawText]
  );

  if (isQueueReady()) {
    await addJob('filter', { interactionId: result.rows[0].id });
  } else {
    await query("UPDATE b2b_interactions SET status = 'error_cola' WHERE id = $1", [result.rows[0].id]);
  }
  return 1;
}

function buildRequestConfig(url, apiKey, authMethod) {
  const config = { method: 'GET', url };
  if (!apiKey) return config;

  switch (authMethod) {
    case 'bearer':
      config.headers = { Authorization: `Bearer ${apiKey}` };
      break;
    case 'header':
      config.headers = { 'X-API-Key': apiKey };
      break;
    case 'query':
      config.params = { api_key: apiKey };
      break;
    default:
      config.headers = { Authorization: `Bearer ${apiKey}` };
  }
  return config;
}

/**
 * Traverse a nested object using a dot-separated path.
 * extractByPath({ data: { calls: [...] } }, "data.calls") => [...]
 */
function extractByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

module.exports = { runB2BPullFetch };
