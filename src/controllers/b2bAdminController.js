const bcrypt = require('bcryptjs');
const axios = require('axios');
const XLSX = require('xlsx');
const { query, transaction } = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const { generateSystemPrompt, suggestAgentName } = require('../services/b2bAgentService');

// ─── B2B Admin Controller ──────────────────────────────────────
// CRUD operations for B2B clients, areas, and agents.
// Protected by authenticate + adminOnly middlewares.

// 4 default agents auto-created per area (as described in the UI modal)
const DEFAULT_AGENTS = [
  { type: 'filter', name: 'Filtro' },
  { type: 'specialized', name: 'Facturación' },
  { type: 'specialized', name: 'Cancelación' },
  { type: 'specialized', name: 'No Navega' }
];

/**
 * Validate, normalize and encrypt pull_config before saving to DB.
 */
function preparePullConfig(raw) {
  if (!raw) return null;
  const { enabled, api_url, api_key, auth_method, default_area_id, fetch_interval_minutes, mapping } = raw;

  if (enabled) {
    if (!api_url) throw new Error('pull_config.api_url is required when pull is enabled');
    if (!default_area_id) throw new Error('pull_config.default_area_id is required when pull is enabled');
  }

  return {
    enabled: Boolean(enabled),
    api_url: api_url || null,
    api_key: api_key && api_key !== '***SET***' ? encrypt(api_key) : (api_key === '***SET***' ? '__KEEP__' : null),
    auth_method: auth_method || 'bearer',
    default_area_id: default_area_id || null,
    fetch_interval_minutes: fetch_interval_minutes || 15,
    mapping: mapping || {}
  };
}

/**
 * GET /api/v1/b2b/admin/clients
 * List all B2B clients
 */
async function listClients(req, res) {
  try {
    const result = await query(
      `SELECT id, company_name, contact_name, email, ai_provider, ai_model, client_type, status, max_agents_per_area, created_at
       FROM b2b_clients
       ORDER BY created_at DESC`
    );

    // Count areas per client
    const areasResult = await query(
      `SELECT b2b_client_id, COUNT(*) as area_count
       FROM b2b_areas
       GROUP BY b2b_client_id`
    );
    const areaCounts = {};
    areasResult.rows.forEach(r => { areaCounts[r.b2b_client_id] = parseInt(r.area_count); });

    // Count interactions per client
    const interactionsResult = await query(
      `SELECT a.b2b_client_id, COUNT(i.id) as interaction_count
       FROM b2b_interactions i
       JOIN b2b_areas a ON i.b2b_area_id = a.id
       GROUP BY a.b2b_client_id`
    );
    const interactionCounts = {};
    interactionsResult.rows.forEach(r => { interactionCounts[r.b2b_client_id] = parseInt(r.interaction_count); });

    const clients = result.rows.map(c => ({
      ...c,
      areas_count: areaCounts[c.id] || 0,
      interactions_count: interactionCounts[c.id] || 0
    }));

    res.json({ success: true, data: clients });
  } catch (error) {
    console.error('[B2B Admin] listClients error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/admin/clients
 * Create a new B2B client
 * Body: { company_name, contact_name, email, password, client_type, ai_provider?, ai_api_key?, ai_model? }
 */
async function createClient(req, res) {
  try {
    const { company_name, contact_name, email, password, client_type, ai_provider, ai_api_key, ai_model, pull_config, max_agents_per_area, web_config } = req.body;

    const validClientTypes = ['agente_calidad', 'agente_web', 'otros'];
    const resolvedType = validClientTypes.includes(client_type) ? client_type : 'agente_calidad';

    // Base validation
    if (!company_name || !contact_name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required: company_name, contact_name, email, password'
      });
    }

    // AI fields are required for agente_calidad and agente_web
    if (resolvedType === 'agente_calidad' || resolvedType === 'agente_web') {
      if (!ai_provider || !ai_api_key || !ai_model) {
        return res.status(400).json({
          success: false,
          error: 'AI fields are required: ai_provider, ai_api_key, ai_model'
        });
      }
      if (!['openai', 'gemini'].includes(ai_provider)) {
        return res.status(400).json({
          success: false,
          error: "ai_provider must be 'openai' or 'gemini'"
        });
      }
    }

    // Check duplicate email
    const existing = await query('SELECT id FROM b2b_clients WHERE email = $1', [email]);
    if (existing.rows[0]) {
      return res.status(409).json({
        success: false,
        error: 'A B2B client with this email already exists'
      });
    }

    // Hash password + encrypt API key (if provided)
    const password_hash = await bcrypt.hash(password, 12);
    const resolvedProvider = ai_provider || 'openai';
    const resolvedModel = ai_model || 'gpt-4o-mini';
    const encrypted_api_key = ai_api_key ? encrypt(ai_api_key) : '';
    const preparedPull = pull_config ? preparePullConfig(pull_config) : null;
    if (preparedPull && preparedPull.api_key === '__KEEP__') preparedPull.api_key = null;

    const agentLimit = max_agents_per_area ? parseInt(max_agents_per_area) : 5;

    const result = await query(
      `INSERT INTO b2b_clients (company_name, contact_name, email, password_hash, ai_provider, ai_api_key, ai_model, client_type, max_agents_per_area, pull_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, company_name, contact_name, email, ai_provider, ai_model, client_type, max_agents_per_area, status, created_at`,
      [company_name, contact_name, email, password_hash, resolvedProvider, encrypted_api_key, resolvedModel, resolvedType, agentLimit,
        preparedPull ? JSON.stringify(preparedPull) : null]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0]
    });

    // Auto-create b2b_web_configs if agente_web
    if (resolvedType === 'agente_web' && result.rows[0]) {
      const newClientId = result.rows[0].id;
      const welcomeMsg = web_config?.welcome_message || '¡Hola! 👋 Soy tu asistente virtual. ¿En qué puedo ayudarte hoy?';
      const widgetColor = web_config?.widget_color || '#0ea5e9';
      try {
        await query(
          `INSERT INTO b2b_web_configs (b2b_client_id, welcome_message, widget_color)
           VALUES ($1, $2, $3)
           ON CONFLICT (b2b_client_id) DO NOTHING`,
          [newClientId, welcomeMsg, widgetColor]
        );
        console.log(`[B2B Admin] Auto-created web config for client ${newClientId}`);
      } catch (webErr) {
        console.error('[B2B Admin] Error auto-creating web config:', webErr.message);
      }
    }

  } catch (error) {
    console.error('[B2B Admin] createClient error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/admin/clients/:clientId
 * Get B2B client details
 */
async function getClient(req, res) {
  try {
    const { clientId } = req.params;

    const result = await query(
      `SELECT id, company_name, contact_name, email, ai_provider, ai_model, client_type, status, max_agents_per_area, pull_config, last_fetched_at, created_at
       FROM b2b_clients WHERE id = $1`,
      [clientId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'B2B client not found' });
    }

    // Mask api_key in pull_config before returning
    const clientData = result.rows[0];
    if (clientData.pull_config && clientData.pull_config.api_key) {
      clientData.pull_config = {
        ...clientData.pull_config,
        api_key: '***SET***',
        api_key_is_set: true
      };
    }

    // Get areas with agent counts
    const areas = await query(
      `SELECT a.id, a.name, a.display_name, a.is_active, a.created_at,
              (SELECT COUNT(*) FROM b2b_agents ag WHERE ag.b2b_area_id = a.id) as agent_count
       FROM b2b_areas a
       WHERE a.b2b_client_id = $1
       ORDER BY a.created_at`,
      [clientId]
    );

    res.json({
      success: true,
      data: {
        ...clientData,
        areas: areas.rows
      }
    });

  } catch (error) {
    console.error('[B2B Admin] getClient error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /api/v1/b2b/admin/clients/:clientId
 * Update a B2B client
 * Body: { company_name?, contact_name?, email?, password?, ai_provider?, ai_api_key?, ai_model?, status? }
 */
async function updateClient(req, res) {
  try {
    const { clientId } = req.params;
    const { company_name, contact_name, email, password, ai_provider, ai_api_key, ai_model, status, max_agents_per_area, pull_config } = req.body;

    // Check client exists
    const existing = await query('SELECT id, pull_config FROM b2b_clients WHERE id = $1', [clientId]);
    if (!existing.rows[0]) {
      return res.status(404).json({ success: false, error: 'B2B client not found' });
    }

    // Build dynamic update
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (company_name) { updates.push(`company_name = $${paramIndex++}`); values.push(company_name); }
    if (contact_name) { updates.push(`contact_name = $${paramIndex++}`); values.push(contact_name); }
    if (email) { updates.push(`email = $${paramIndex++}`); values.push(email); }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(hash);
    }
    if (ai_provider) { updates.push(`ai_provider = $${paramIndex++}`); values.push(ai_provider); }
    if (ai_api_key) {
      updates.push(`ai_api_key = $${paramIndex++}`);
      values.push(encrypt(ai_api_key));
    }
    if (ai_model) { updates.push(`ai_model = $${paramIndex++}`); values.push(ai_model); }
    if (status) { updates.push(`status = $${paramIndex++}`); values.push(status); }
    if (max_agents_per_area !== undefined) {
      updates.push(`max_agents_per_area = $${paramIndex++}`);
      values.push(parseInt(max_agents_per_area));
    }
    if (pull_config !== undefined) {
      if (pull_config === null) {
        updates.push(`pull_config = $${paramIndex++}`);
        values.push(null);
      } else {
        const prepared = preparePullConfig(pull_config);
        // If api_key is '__KEEP__', preserve the existing encrypted key
        if (prepared.api_key === '__KEEP__' && existing.rows[0].pull_config) {
          prepared.api_key = existing.rows[0].pull_config.api_key;
        } else if (prepared.api_key === '__KEEP__') {
          prepared.api_key = null;
        }
        updates.push(`pull_config = $${paramIndex++}`);
        values.push(JSON.stringify(prepared));
      }
      updates.push('last_fetched_at = NULL');
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(clientId);
    const result = await query(
      `UPDATE b2b_clients SET ${updates.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, company_name, contact_name, email, ai_provider, ai_model, client_type, max_agents_per_area, status, created_at`,
      values
    );

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('[B2B Admin] updateClient error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/admin/clients/:clientId/areas
 * List areas for a B2B client
 */
async function listAreas(req, res) {
  try {
    const { clientId } = req.params;

    // Get client info
    const clientResult = await query(
      'SELECT id, company_name, ai_provider, ai_model FROM b2b_clients WHERE id = $1',
      [clientId]
    );
    if (!clientResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'B2B client not found' });
    }

    const result = await query(
      `SELECT a.id, a.name, a.display_name, a.is_active, a.created_at,
              (SELECT COUNT(*) FROM b2b_agents ag WHERE ag.b2b_area_id = a.id) as agents_count,
              (SELECT COUNT(*) FROM b2b_interactions i WHERE i.b2b_area_id = a.id) as interactions_count
       FROM b2b_areas a
       WHERE a.b2b_client_id = $1
       ORDER BY a.created_at`,
      [clientId]
    );

    res.json({
      success: true,
      data: {
        client: clientResult.rows[0],
        areas: result.rows
      }
    });

  } catch (error) {
    console.error('[B2B Admin] listAreas error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/admin/clients/:clientId/areas
 * Create an area and auto-create 4 default agents (filter + 3 specialized)
 * Body: { name, display_name }
 */
async function createArea(req, res) {
  try {
    const { clientId } = req.params;
    const { name, display_name } = req.body;

    if (!name || !display_name) {
      return res.status(400).json({
        success: false,
        error: 'name and display_name are required'
      });
    }

    // Verify client exists
    const clientCheck = await query('SELECT id FROM b2b_clients WHERE id = $1', [clientId]);
    if (!clientCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'B2B client not found' });
    }

    // Create area + default agents in a transaction
    const result = await transaction(async (client) => {
      // Create area
      const areaResult = await client.query(
        `INSERT INTO b2b_areas (b2b_client_id, name, display_name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [clientId, name, display_name]
      );
      const area = areaResult.rows[0];

      // Create 4 default agents (empty prompts — admin fills them later)
      for (const agent of DEFAULT_AGENTS) {
        await client.query(
          `INSERT INTO b2b_agents (b2b_area_id, type, name)
           VALUES ($1, $2, $3)`,
          [area.id, agent.type, agent.name]
        );
      }

      return area;
    });

    // Fetch agents for response
    const agents = await query(
      'SELECT id, type, name, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, is_active, created_at FROM b2b_agents WHERE b2b_area_id = $1 ORDER BY type, name',
      [result.id]
    );

    res.status(201).json({
      success: true,
      data: {
        area: {
          id: result.id,
          name: result.name,
          display_name: result.display_name,
          is_active: result.is_active
        },
        agents: agents.rows
      }
    });

  } catch (error) {
    console.error('[B2B Admin] createArea error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /api/v1/b2b/admin/areas/:areaId/agents
 * List agents for an area
 */
async function listAgents(req, res) {
  try {
    const { areaId } = req.params;

    // Get area + client info (with ownership check for B2B clients)
    let areaCheck;
    if (req.b2bClient) {
      areaCheck = await query(
        'SELECT a.id, a.b2b_client_id FROM b2b_areas a WHERE a.id = $1 AND a.b2b_client_id = $2',
        [areaId, req.b2bClient.id]
      );
    } else {
      areaCheck = await query('SELECT id, b2b_client_id FROM b2b_areas WHERE id = $1', [areaId]);
    }

    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    // Get agent limit
    const limitResult = await query(
      'SELECT max_agents_per_area FROM b2b_clients WHERE id = $1',
      [areaCheck.rows[0].b2b_client_id]
    );
    const maxAgents = limitResult.rows[0]?.max_agents_per_area || 5;

    const result = await query(
      `SELECT id, type, name, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, is_active, created_at, updated_at
       FROM b2b_agents
       WHERE b2b_area_id = $1
       ORDER BY type, name`,
      [areaId]
    );

    res.json({
      success: true,
      data: result.rows,
      max_agents_per_area: maxAgents
    });

  } catch (error) {
    console.error('[B2B Admin] listAgents error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /api/v1/b2b/admin/agents/:agentId/prompt
 * Update an agent's configuration (v2: supports all template fields)
 * Body: { name?, system_prompt?, description?, evaluation_template?, deliverable_template?, feedback_accumulated? }
 */
async function updatePrompt(req, res) {
  try {
    const { agentId } = req.params;
    const { system_prompt, name, description, evaluation_template, deliverable_template, feedback_accumulated } = req.body;

    const hasAnyField = [system_prompt, name, description, evaluation_template, deliverable_template, feedback_accumulated]
      .some(f => f !== undefined);

    if (!hasAnyField) {
      return res.status(400).json({
        success: false,
        error: 'At least one field is required: name, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated'
      });
    }

    // If B2B client, verify agent ownership
    if (req.b2bClient) {
      const check = await query(
        `SELECT ag.id, ag.type, ag.b2b_area_id FROM b2b_agents ag
         JOIN b2b_areas a ON ag.b2b_area_id = a.id
         WHERE ag.id = $1 AND a.b2b_client_id = $2`,
        [agentId, req.b2bClient.id]
      );
      if (!check.rows[0]) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
    }

    // Build dynamic update
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (system_prompt !== undefined) {
      updates.push(`system_prompt = $${paramIndex++}`);
      values.push(system_prompt);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (evaluation_template !== undefined) {
      updates.push(`evaluation_template = $${paramIndex++}`);
      values.push(evaluation_template);
    }
    if (deliverable_template !== undefined) {
      updates.push(`deliverable_template = $${paramIndex++}`);
      values.push(deliverable_template);
    }
    if (feedback_accumulated !== undefined) {
      updates.push(`feedback_accumulated = $${paramIndex++}`);
      values.push(feedback_accumulated);
    }
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'name cannot be empty' });
      }
      // Check for duplicate name in same area
      const agentInfo = await query('SELECT b2b_area_id, type FROM b2b_agents WHERE id = $1', [agentId]);
      if (agentInfo.rows[0]?.type === 'filter') {
        return res.status(400).json({ success: false, error: 'Cannot rename the filter agent' });
      }
      if (agentInfo.rows[0]) {
        const dup = await query(
          'SELECT id FROM b2b_agents WHERE b2b_area_id = $1 AND name = $2 AND id != $3',
          [agentInfo.rows[0].b2b_area_id, trimmed, agentId]
        );
        if (dup.rows[0]) {
          return res.status(409).json({ success: false, error: `An agent named "${trimmed}" already exists in this area` });
        }
      }
      updates.push(`name = $${paramIndex++}`);
      values.push(trimmed);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(agentId);

    const result = await query(
      `UPDATE b2b_agents SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, type, name, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, is_active, updated_at`,
      values
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('[B2B Admin] updatePrompt error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/admin/agents/:agentId/generate-prompt
 * Generate a system prompt using AI from a plain description
 * Body: { description }
 */
async function generatePromptEndpoint(req, res) {
  try {
    const { agentId } = req.params;
    const { description } = req.body;

    if (!description) {
      return res.status(400).json({
        success: false,
        error: 'description is required'
      });
    }

    // Get the agent's area → client to get AI config (with ownership check for B2B clients)
    const agentQuery = req.b2bClient
      ? `SELECT ag.id, ag.b2b_area_id, a.b2b_client_id
         FROM b2b_agents ag
         JOIN b2b_areas a ON ag.b2b_area_id = a.id
         WHERE ag.id = $1 AND a.b2b_client_id = $2`
      : `SELECT ag.id, ag.b2b_area_id, a.b2b_client_id
         FROM b2b_agents ag
         JOIN b2b_areas a ON ag.b2b_area_id = a.id
         WHERE ag.id = $1`;

    const agentParams = req.b2bClient ? [agentId, req.b2bClient.id] : [agentId];
    const agentResult = await query(agentQuery, agentParams);

    if (!agentResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const { b2b_client_id } = agentResult.rows[0];

    // Get AI config
    const clientResult = await query(
      'SELECT ai_provider, ai_api_key, ai_model FROM b2b_clients WHERE id = $1',
      [b2b_client_id]
    );
    const aiConfig = clientResult.rows[0];

    // Generate prompt + suggest name
    const [generatedPrompt, suggestedName] = await Promise.all([
      generateSystemPrompt(description, aiConfig),
      suggestAgentName(description, aiConfig)
    ]);

    // Save to evaluation_template (v2) AND system_prompt (legacy compat)
    // Also save the description used to generate the prompt
    await query(
      `UPDATE b2b_agents
       SET evaluation_template = $1, system_prompt = $1, description = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [generatedPrompt, description, agentId]
    );

    res.json({
      success: true,
      data: {
        generated_prompt: generatedPrompt,
        suggested_name: suggestedName,
        description_used: description
      }
    });

  } catch (error) {
    console.error('[B2B Admin] generatePrompt error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/admin/areas/:areaId/agents  (admin)
 * POST /api/v1/b2b/areas/:areaId/agents         (b2b client)
 * Create a specialized agent for an area
 * Body: { name, system_prompt?, description?, evaluation_template?, deliverable_template? }
 */
async function createAgent(req, res) {
  try {
    const { areaId } = req.params;
    const { name, system_prompt, description, evaluation_template, deliverable_template } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'name is required'
      });
    }

    // Verify area exists (and belongs to b2b client if called from client panel)
    let areaCheck;
    if (req.b2bClient) {
      areaCheck = await query(
        'SELECT a.id, a.b2b_client_id FROM b2b_areas a WHERE a.id = $1 AND a.b2b_client_id = $2',
        [areaId, req.b2bClient.id]
      );
    } else {
      areaCheck = await query('SELECT id, b2b_client_id FROM b2b_areas WHERE id = $1', [areaId]);
    }

    if (!areaCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Area not found' });
    }

    const b2bClientId = areaCheck.rows[0].b2b_client_id;

    // Check agent limit per area
    const limitResult = await query(
      'SELECT max_agents_per_area FROM b2b_clients WHERE id = $1',
      [b2bClientId]
    );
    const maxAgents = limitResult.rows[0]?.max_agents_per_area || 5;

    const countResult = await query(
      "SELECT COUNT(*) as cnt FROM b2b_agents WHERE b2b_area_id = $1 AND type = 'specialized'",
      [areaId]
    );
    const currentCount = parseInt(countResult.rows[0].cnt);

    if (currentCount >= maxAgents) {
      return res.status(403).json({
        success: false,
        error: `Limite alcanzado: maximo ${maxAgents} agentes especializados por area`
      });
    }

    // Check duplicate name in same area
    const duplicate = await query(
      'SELECT id FROM b2b_agents WHERE b2b_area_id = $1 AND name = $2',
      [areaId, name]
    );
    if (duplicate.rows[0]) {
      return res.status(409).json({
        success: false,
        error: `An agent named "${name}" already exists in this area`
      });
    }

    const result = await query(
      `INSERT INTO b2b_agents (b2b_area_id, type, name, system_prompt, description, evaluation_template, deliverable_template)
       VALUES ($1, 'specialized', $2, $3, $4, $5, $6)
       RETURNING id, type, name, system_prompt, description, evaluation_template, deliverable_template, feedback_accumulated, is_active, created_at`,
      [areaId, name, system_prompt || null, description || null, evaluation_template || null, deliverable_template || null]
    );

    res.status(201).json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('[B2B Admin] createAgent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /api/v1/b2b/admin/agents/:agentId  (admin)
 * DELETE /api/v1/b2b/agents/:agentId         (b2b client)
 * Delete a specialized agent (cannot delete filter agents)
 */
async function deleteAgent(req, res) {
  try {
    const { agentId } = req.params;

    // Get agent + verify ownership if b2b client
    let agentCheck;
    if (req.b2bClient) {
      agentCheck = await query(
        `SELECT ag.id, ag.type, ag.name
         FROM b2b_agents ag
         JOIN b2b_areas a ON ag.b2b_area_id = a.id
         WHERE ag.id = $1 AND a.b2b_client_id = $2`,
        [agentId, req.b2bClient.id]
      );
    } else {
      agentCheck = await query(
        'SELECT id, type, name FROM b2b_agents WHERE id = $1',
        [agentId]
      );
    }

    if (!agentCheck.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    if (agentCheck.rows[0].type === 'filter') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete the filter agent — it is required for the pipeline'
      });
    }

    await query('DELETE FROM b2b_agents WHERE id = $1', [agentId]);

    res.json({
      success: true,
      data: { id: agentId, deleted: true }
    });

  } catch (error) {
    console.error('[B2B Admin] deleteAgent error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/b2b/admin/pull-detect
 * Test a client API and auto-detect field mapping.
 * Body: { api_url, api_key, auth_method }
 */
async function detectPullFields(req, res) {
  try {
    const { api_url, api_key, auth_method = 'bearer' } = req.body;

    if (!api_url) {
      return res.status(400).json({ success: false, error: 'api_url es requerido' });
    }

    // Build request config
    const config = { timeout: 15000, headers: {} };
    if (api_key) {
      if (auth_method === 'bearer') {
        config.headers['Authorization'] = `Bearer ${api_key}`;
      } else if (auth_method === 'header') {
        config.headers['X-API-Key'] = api_key;
      }
    }
    const url = (auth_method === 'query' && api_key)
      ? `${api_url}${api_url.includes('?') ? '&' : '?'}api_key=${api_key}`
      : api_url;

    // Fetch
    const response = await axios.get(url, config);
    const json = response.data;

    if (!json || typeof json !== 'object') {
      return res.status(400).json({ success: false, error: 'La API no devolvio JSON valido' });
    }

    // --- Auto-detect logic ---
    // 1. Find the array (data_path)
    const arrayInfo = findArray(json, '', 0);
    if (!arrayInfo) {
      return res.status(400).json({
        success: false,
        error: 'No se encontro un array de datos en la respuesta JSON',
        raw_keys: Object.keys(json),
      });
    }

    const { path: dataPath, items } = arrayInfo;
    const sample = items[0];
    if (!sample || typeof sample !== 'object') {
      return res.status(400).json({ success: false, error: 'El array esta vacio o no contiene objetos' });
    }

    const keys = Object.keys(sample);

    // 2. Guess mapping from field names
    const mapping = {
      data_path: dataPath,
      id_field: guess(keys, ['id', 'call_id', 'record_id', 'codigo', 'code', 'uuid', 'interaction_id', '_id']),
      type_field: guess(keys, ['type', 'tipo', 'channel', 'canal', 'category', 'kind']),
      default_type: guessDefaultType(sample, keys),
      audio_url_field: guess(keys, ['audio_url', 'recording_url', 'url_grabacion', 'audio', 'recording', 'media_url', 'file_url', 'sound_url', 'call_recording']),
      date_field: guess(keys, ['date', 'fecha', 'timestamp', 'created_at', 'created', 'datetime', 'time', 'recorded_at']),
      email_from_field: guess(keys, ['from', 'email_from', 'sender', 'remitente', 'from_email', 'origin']),
      email_subject_field: guess(keys, ['subject', 'asunto', 'titulo', 'title', 'email_subject']),
      email_body_field: guess(keys, ['body', 'content', 'contenido', 'text', 'message', 'email_body', 'descripcion']),
    };

    res.json({
      success: true,
      data: {
        mapping,
        sample_item: sample,
        total_items: items.length,
        all_fields: keys,
      }
    });

  } catch (error) {
    if (error.response) {
      return res.status(400).json({
        success: false,
        error: `La API respondio con status ${error.response.status}: ${error.response.statusText}`,
      });
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(400).json({ success: false, error: 'No se pudo conectar a la URL proporcionada' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(400).json({ success: false, error: 'La API tardo demasiado en responder (timeout 15s)' });
    }
    console.error('[B2B Admin] detectPullFields error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Error al consultar la API' });
  }
}

// --- Helper functions for auto-detect ---

/** Recursively find the first array of objects in the JSON (max depth 4) */
function findArray(obj, currentPath, depth) {
  if (depth > 4) return null;
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
    return { path: currentPath, items: obj };
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of Object.keys(obj)) {
      const newPath = currentPath ? `${currentPath}.${key}` : key;
      const result = findArray(obj[key], newPath, depth + 1);
      if (result) return result;
    }
  }
  return null;
}

/** Match a key list against known patterns, return first match */
function guess(keys, patterns) {
  const lower = keys.map(k => k.toLowerCase());
  for (const p of patterns) {
    const idx = lower.indexOf(p.toLowerCase());
    if (idx !== -1) return keys[idx];
  }
  // Partial match
  for (const p of patterns) {
    const idx = lower.findIndex(k => k.includes(p.toLowerCase()));
    if (idx !== -1) return keys[idx];
  }
  return '';
}

/** Guess if the data is mostly calls or emails */
function guessDefaultType(sample, keys) {
  const lower = keys.map(k => k.toLowerCase());
  const hasAudio = lower.some(k => k.includes('audio') || k.includes('recording') || k.includes('grabacion') || k.includes('call'));
  const hasEmail = lower.some(k => k.includes('email') || k.includes('subject') || k.includes('body') || k.includes('sender'));
  if (hasAudio && !hasEmail) return 'call';
  if (hasEmail && !hasAudio) return 'email';
  return 'call';
}

/**
 * POST /api/v1/b2b/.../agents/:agentId/upload-template
 * Upload an Excel file as evaluation or deliverable template.
 * Expects multer file in req.file, and req.body.template_type = 'evaluation' | 'deliverable'
 */
async function uploadTemplate(req, res) {
  try {
    const { agentId } = req.params;
    const { template_type } = req.body;

    if (!template_type || !['evaluation', 'deliverable'].includes(template_type)) {
      return res.status(400).json({
        success: false,
        error: 'template_type is required and must be "evaluation" or "deliverable"'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload an Excel file (.xlsx or .xls)'
      });
    }

    // If B2B client, verify agent ownership
    if (req.b2bClient) {
      const check = await query(
        `SELECT ag.id FROM b2b_agents ag
         JOIN b2b_areas a ON ag.b2b_area_id = a.id
         WHERE ag.id = $1 AND a.b2b_client_id = $2`,
        [agentId, req.b2bClient.id]
      );
      if (!check.rows[0]) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
    }

    // Parse the Excel file from buffer
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'The Excel file has no sheets'
      });
    }

    // Parse all sheets into a structured object
    const parsedData = {};
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      
      // Carry-over logic for merged cells (if evaluation template)
      if (template_type === 'evaluation' && rows.length > 0) {
        const keys = Object.keys(rows[0]);
        const keysLower = keys.map(k => k.toLowerCase());
        
        // Find columns likely to be merged (Category, Description, Factor)
        const columnsToCarry = keys.filter((k, i) => {
          const l = keysLower[i];
          return l.includes('criterio') || l.includes('descripcion') || l.includes('descripción') || l.includes('tipo') || l.includes('categor');
        });

        const lastValues = {};
        for (const row of rows) {
          columnsToCarry.forEach(k => {
            if (row[k] !== undefined && String(row[k]).trim() !== '') {
              lastValues[k] = row[k];
            } else if (lastValues[k] !== undefined) {
              row[k] = lastValues[k];
            }
          });
        }
      }
      parsedData[sheetName] = rows;
    }

    // Build the stored representation
    let textContent = '';
    
    // For evaluation templates, we prefer JSON to maintain exact structure
    if (template_type === 'evaluation') {
        const allRows = Object.values(parsedData).flat();
        textContent = JSON.stringify(allRows, null, 2);
    } else {
        // Fallback or Deliverable: Readable text representation
        for (const [sheetName, rows] of Object.entries(parsedData)) {
          if (sheetNames.length > 1) {
            textContent += `\n=== ${sheetName} ===\n`;
          }
          if (rows.length === 0) continue;
          const headers = Object.keys(rows[0]);
          textContent += headers.join(' | ') + '\n';
          textContent += headers.map(() => '---').join(' | ') + '\n';
          for (const row of rows) {
            textContent += headers.map(h => String(row[h] || '')).join(' | ') + '\n';
          }
        }
    }

    // Store in the appropriate column
    const column = template_type === 'evaluation' ? 'evaluation_template' : 'deliverable_template';

    const result = await query(
      `UPDATE b2b_agents SET ${column} = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, type, name, description, evaluation_template, deliverable_template, feedback_accumulated, is_active, updated_at`,
      [textContent.trim(), agentId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({
      success: true,
      data: result.rows[0],
      parsed_summary: {
        sheets: sheetNames,
        total_rows: Object.values(parsedData).reduce((sum, rows) => sum + rows.length, 0),
        file_name: req.file.originalname
      }
    });

  } catch (error) {
    console.error('[B2B Admin] uploadTemplate error:', error);
    if (error.message?.includes('password') || error.message?.includes('encrypt')) {
      return res.status(400).json({ success: false, error: 'Invalid Excel file format' });
    }
    res.status(500).json({ success: false, error: 'Error processing Excel file' });
  }
}

/**
 * POST /agents/:agentId/criteria
 * Add a single criterion to the evaluation_template JSON array.
 */
async function addCriterion(req, res) {
  try {
    const { agentId } = req.params;
    const newCriterion = req.body;

    if (!newCriterion || Object.keys(newCriterion).length === 0) {
      return res.status(400).json({ success: false, error: 'Criterion data is required' });
    }

    // Get current template
    const agentResult = await query('SELECT evaluation_template FROM b2b_agents WHERE id = $1', [agentId]);
    if (!agentResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    let criteria = [];
    const raw = agentResult.rows[0].evaluation_template;
    if (raw && raw.trim().startsWith('[')) {
      try { criteria = JSON.parse(raw); } catch { criteria = []; }
    }

    // Auto-assign next ID
    const maxId = criteria.reduce((max, c) => Math.max(max, Number(c.id || c.ID || c.Id || 0)), 0);
    newCriterion.id = maxId + 1;

    criteria.push(newCriterion);

    const result = await query(
      `UPDATE b2b_agents SET evaluation_template = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, evaluation_template, updated_at`,
      [JSON.stringify(criteria, null, 2), agentId]
    );

    res.json({ success: true, data: result.rows[0], added_criterion: newCriterion });
  } catch (error) {
    console.error('[B2B Admin] addCriterion error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /agents/:agentId/criteria/:criterionId
 * Update a single criterion in the evaluation_template.
 */
async function updateCriterion(req, res) {
  try {
    const { agentId, criterionId } = req.params;
    const updates = req.body;

    const agentResult = await query('SELECT evaluation_template FROM b2b_agents WHERE id = $1', [agentId]);
    if (!agentResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    let criteria = [];
    const raw = agentResult.rows[0].evaluation_template;
    if (raw && raw.trim().startsWith('[')) {
      try { criteria = JSON.parse(raw); } catch { criteria = []; }
    }

    const idx = criteria.findIndex(c => String(c.id || c.ID || c.Id) === String(criterionId));
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Criterion not found' });
    }

    // Merge updates into existing criterion (preserve id)
    criteria[idx] = { ...criteria[idx], ...updates, id: criteria[idx].id || criteria[idx].ID || criteria[idx].Id };

    const result = await query(
      `UPDATE b2b_agents SET evaluation_template = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, evaluation_template, updated_at`,
      [JSON.stringify(criteria, null, 2), agentId]
    );

    res.json({ success: true, data: result.rows[0], updated_criterion: criteria[idx] });
  } catch (error) {
    console.error('[B2B Admin] updateCriterion error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /agents/:agentId/criteria/:criterionId
 * Remove a single criterion from the evaluation_template.
 */
async function deleteCriterion(req, res) {
  try {
    const { agentId, criterionId } = req.params;

    const agentResult = await query('SELECT evaluation_template FROM b2b_agents WHERE id = $1', [agentId]);
    if (!agentResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    let criteria = [];
    const raw = agentResult.rows[0].evaluation_template;
    if (raw && raw.trim().startsWith('[')) {
      try { criteria = JSON.parse(raw); } catch { criteria = []; }
    }

    const before = criteria.length;
    criteria = criteria.filter(c => String(c.id || c.ID || c.Id) !== String(criterionId));

    if (criteria.length === before) {
      return res.status(404).json({ success: false, error: 'Criterion not found' });
    }

    const result = await query(
      `UPDATE b2b_agents SET evaluation_template = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, evaluation_template, updated_at`,
      [JSON.stringify(criteria, null, 2), agentId]
    );

    res.json({ success: true, data: result.rows[0], deleted_id: criterionId });
  } catch (error) {
    console.error('[B2B Admin] deleteCriterion error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

module.exports = {
  listClients,
  createClient,
  getClient,
  updateClient,
  listAreas,
  createArea,
  listAgents,
  createAgent,
  deleteAgent,
  updatePrompt,
  uploadTemplate,
  addCriterion,
  updateCriterion,
  deleteCriterion,
  generatePrompt: generatePromptEndpoint,
  detectPullFields,
};
