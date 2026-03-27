const { query, transaction } = require('../config/database');
const { hashPassword, generateVerificationCode } = require('../utils/hash');
const { CLIENT_STATUS, SERVICE_STATUS, PAYMENT_STATUS, TRIAL } = require('../config/constants');
const { sendCredentialsEmail, sendPaymentConfirmedEmail, sendVoiceActivatedEmail } = require('../services/emailService');
const metaOAuth = require('../services/metaOAuthService');
const { addCredits, getAllClientsUsageSummary, getMonthlyUsage, getDailyUsage, checkBalance } = require('../services/billingService');

// ==================== DASHBOARD ====================

const getDashboard = async (req, res) => {
  try {
    // Total de clientes
    const clientsResult = await query('SELECT COUNT(*) as total FROM clients');
    const activeClientsResult = await query("SELECT COUNT(*) as total FROM clients WHERE status = 'active'");

    // Trials
    const trialsResult = await query(`
      SELECT COUNT(*) as total FROM client_services WHERE status = 'trial'
    `);

    const expiringTrialsResult = await query(`
      SELECT COUNT(*) as total FROM client_services
      WHERE status = 'trial' AND trial_ends_at <= CURRENT_TIMESTAMP + INTERVAL '2 days'
    `);

    // Pagos del mes
    const monthlyIncomeResult = await query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments
      WHERE status = 'completed'
      AND created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
    `);

    // Pagos pendientes
    const pendingPaymentsResult = await query(`
      SELECT COUNT(*) as total FROM payments WHERE status = 'pending'
    `);

    // Clientes nuevos esta semana
    const newClientsResult = await query(`
      SELECT COUNT(*) as total FROM clients
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
    `);

    // Servicios más contratados
    const topServicesResult = await query(`
      SELECT s.name, s.code, COUNT(cs.id) as total
      FROM services s
      LEFT JOIN client_services cs ON s.id = cs.service_id
      GROUP BY s.id, s.name, s.code
      ORDER BY total DESC
    `);

    // Últimos registros
    const latestClientsResult = await query(`
      SELECT id, name, email, created_at
      FROM clients
      ORDER BY created_at DESC
      LIMIT 5
    `);

    // Pagos pendientes de validación
    const pendingValidationResult = await query(`
      SELECT p.*, c.name as client_name, c.email as client_email
      FROM payments p
      JOIN clients c ON p.client_id = c.id
      WHERE p.status = 'pending' AND p.method = 'transfer'
      ORDER BY p.created_at DESC
      LIMIT 5
    `);

    res.json({
      success: true,
      data: {
        stats: {
          totalClients: parseInt(clientsResult.rows[0].total),
          activeClients: parseInt(activeClientsResult.rows[0].total),
          totalTrials: parseInt(trialsResult.rows[0].total),
          expiringTrials: parseInt(expiringTrialsResult.rows[0].total),
          monthlyIncome: parseFloat(monthlyIncomeResult.rows[0].total),
          pendingPayments: parseInt(pendingPaymentsResult.rows[0].total),
          newClientsThisWeek: parseInt(newClientsResult.rows[0].total)
        },
        topServices: topServicesResult.rows,
        latestClients: latestClientsResult.rows,
        pendingValidation: pendingValidationResult.rows
      }
    });

  } catch (error) {
    console.error('Error en getDashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== GESTIÓN DE CLIENTES ====================

const getClients = async (req, res) => {
  try {
    const { search, status } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND c.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM clients c ${whereClause}`,
      params
    );

    const clientsResult = await query(`
      SELECT c.*, b.name as business_name, b.industry,
             (SELECT COUNT(*) FROM client_services WHERE client_id = c.id) as services_count
      FROM clients c
      LEFT JOIN businesses b ON c.id = b.client_id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      data: {
        clients: clientsResult.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error en getClients:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getClient = async (req, res) => {
  try {
    const { id } = req.params;

    const clientResult = await query(`
      SELECT c.*, b.*,
             c.id as client_id, c.name as client_name, c.email as client_email,
             b.name as business_name
      FROM clients c
      LEFT JOIN businesses b ON c.id = b.client_id
      WHERE c.id = $1
    `, [id]);

    if (clientResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Cliente no encontrado'
      });
    }

    // Obtener servicios del cliente
    const servicesResult = await query(`
      SELECT cs.*, s.name, s.code, s.icon, s.color, s.price_monthly,
             CASE
               WHEN cs.status = 'trial' THEN
                 GREATEST(0, EXTRACT(DAY FROM (cs.trial_ends_at - CURRENT_TIMESTAMP)))
               WHEN cs.status = 'active' THEN
                 GREATEST(0, EXTRACT(DAY FROM (cs.subscription_ends_at - CURRENT_TIMESTAMP)))
               ELSE 0
             END as days_remaining
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
    `, [id]);

    // Obtener pagos del cliente
    const paymentsResult = await query(`
      SELECT * FROM payments
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [id]);

    res.json({
      success: true,
      data: {
        client: clientResult.rows[0],
        services: servicesResult.rows,
        payments: paymentsResult.rows
      }
    });

  } catch (error) {
    console.error('Error en getClient:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const createClient = async (req, res) => {
  try {
    const { email, name, phone, password, businessName, industry, country } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email, nombre y contraseña son requeridos'
      });
    }

    // Verificar si existe
    const existingResult = await query('SELECT id FROM clients WHERE email = $1', [email.toLowerCase()]);
    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Este email ya está registrado'
      });
    }

    const result = await transaction(async (client) => {
      const passwordHash = await hashPassword(password);

      // Crear cliente
      const creatorId = req.user.id === 'admin-env' ? null : req.user.id;
      const clientResult = await client.query(`
        INSERT INTO clients (email, password_hash, name, phone, status, email_verified, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [email.toLowerCase(), passwordHash, name, phone, CLIENT_STATUS.ACTIVE, true, creatorId]);

      const newClient = clientResult.rows[0];

      // Crear negocio si se proporciona
      if (businessName) {
        await client.query(`
          INSERT INTO businesses (client_id, name, industry, country)
          VALUES ($1, $2, $3, $4)
        `, [newClient.id, businessName, industry, country]);
      }

      return newClient;
    });

    // Enviar credenciales por email
    sendCredentialsEmail(email.toLowerCase(), name, password)
      .catch(err => console.error('Error enviando credenciales por email:', err.message));

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente. Credenciales enviadas por email.',
      data: {
        client: result
      }
    });

  } catch (error) {
    console.error('Error en createClient:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, status, businessName, industry, country, description, website } = req.body;

    await transaction(async (client) => {
      // Actualizar cliente
      if (name || phone || status) {
        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (name) {
          updates.push(`name = $${paramIndex++}`);
          values.push(name);
        }
        if (phone) {
          updates.push(`phone = $${paramIndex++}`);
          values.push(phone);
        }
        if (status) {
          updates.push(`status = $${paramIndex++}`);
          values.push(status);
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);

        await client.query(
          `UPDATE clients SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
          values
        );
      }

      // Actualizar o crear negocio
      if (businessName) {
        const businessExists = await client.query(
          'SELECT id FROM businesses WHERE client_id = $1',
          [id]
        );

        if (businessExists.rows.length > 0) {
          await client.query(`
            UPDATE businesses
            SET name = $1, industry = $2, country = $3, description = $4, website = $5, updated_at = CURRENT_TIMESTAMP
            WHERE client_id = $6
          `, [businessName, industry, country, description, website, id]);
        } else {
          await client.query(`
            INSERT INTO businesses (client_id, name, industry, country, description, website)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [id, businessName, industry, country, description, website]);
        }
      }
    });

    res.json({
      success: true,
      message: 'Cliente actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error en updateClient:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const deleteClient = async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete - cambiar estado a inactive
    await query(
      "UPDATE clients SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    res.json({
      success: true,
      message: 'Cliente desactivado exitosamente'
    });

  } catch (error) {
    console.error('Error en deleteClient:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== GESTIÓN DE SERVICIOS POR CLIENTE ====================

const assignService = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { serviceId, config, planType = 'pro' } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio requerido'
      });
    }

    // Verificar que el servicio existe
    const serviceResult = await query('SELECT * FROM services WHERE id = $1', [serviceId]);
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    // Verificar si ya tiene el servicio
    const existingResult = await query(
      'SELECT id FROM client_services WHERE client_id = $1 AND service_id = $2',
      [clientId, serviceId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'El cliente ya tiene este servicio asignado'
      });
    }

    // Calcular fechas de trial
    const trialStartedAt = new Date();
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL.DURATION_DAYS);

    const result = await transaction(async (client) => {
      // Crear asignación de servicio
      const csResult = await client.query(`
        INSERT INTO client_services (client_id, service_id, status, config, trial_started_at, trial_ends_at, plan_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [clientId, serviceId, SERVICE_STATUS.TRIAL, config || {}, trialStartedAt, trialEndsAt, planType]);

      const clientService = csResult.rows[0];

      // Crear configuración de bot por defecto
      await client.query(`
        INSERT INTO bot_configs (client_service_id, welcome_message, fallback_message)
        VALUES ($1, $2, $3)
      `, [
        clientService.id,
        '¡Hola! Soy el asistente virtual. ¿En qué puedo ayudarte?',
        'Lo siento, no entendí tu mensaje. ¿Podrías reformularlo?'
      ]);

      return clientService;
    });

    res.status(201).json({
      success: true,
      message: 'Servicio asignado exitosamente',
      data: {
        clientService: result,
        service: serviceResult.rows[0]
      }
    });

  } catch (error) {
    console.error('Error en assignService:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateClientService = async (req, res) => {
  try {
    const { clientId, serviceId } = req.params;
    const { status, config, subscriptionEndsAt, planType } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);

      if (status === SERVICE_STATUS.ACTIVE) {
        updates.push(`subscription_started_at = CURRENT_TIMESTAMP`);
      }
    }

    if (config) {
      updates.push(`config = $${paramIndex++}`);
      values.push(JSON.stringify(config));
    }

    if (subscriptionEndsAt) {
      updates.push(`subscription_ends_at = $${paramIndex++}`);
      values.push(subscriptionEndsAt);
    }

    if (planType) {
      updates.push(`plan_type = $${paramIndex++}`);
      values.push(planType);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    values.push(clientId);
    values.push(serviceId);

    await query(`
      UPDATE client_services
      SET ${updates.join(', ')}
      WHERE client_id = $${paramIndex} AND id = $${paramIndex + 1}
    `, values);

    res.json({
      success: true,
      message: 'Servicio actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error en updateClientService:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const deleteClientService = async (req, res) => {
  try {
    const { clientId, serviceId } = req.params;
    await query(
      'DELETE FROM client_services WHERE client_id = $1 AND id = $2',
      [clientId, serviceId]
    );
    res.json({ success: true, message: 'Servicio eliminado correctamente' });
  } catch (error) {
    console.error('Error en deleteClientService:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ==================== GESTIÓN DE PAGOS ====================

const getPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, method } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND p.status = $${paramIndex++}`;
      params.push(status);
    }

    if (method) {
      whereClause += ` AND p.method = $${paramIndex++}`;
      params.push(method);
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM payments p ${whereClause}`,
      params
    );

    const paymentsResult = await query(`
      SELECT p.*, c.name as client_name, c.email as client_email,
             s.name as service_name, s.code as service_code
      FROM payments p
      JOIN clients c ON p.client_id = c.id
      LEFT JOIN client_services cs ON p.client_service_id = cs.id
      LEFT JOIN services s ON cs.service_id = s.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      data: {
        payments: paymentsResult.rows,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(countResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error en getPayments:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const validatePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { approved, notes } = req.body;

    const paymentResult = await query('SELECT * FROM payments WHERE id = $1', [id]);

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Pago no encontrado'
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      return res.status(400).json({
        success: false,
        error: 'Este pago ya fue procesado'
      });
    }

    await transaction(async (client) => {
      const newStatus = approved ? PAYMENT_STATUS.COMPLETED : PAYMENT_STATUS.FAILED;

      const validatedBy = req.user.id === 'admin-env' ? null : req.user.id;
      // Actualizar pago
      await client.query(`
        UPDATE payments
        SET status = $1, validated_by = $2, validated_at = CURRENT_TIMESTAMP, notes = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
      `, [newStatus, validatedBy, notes, id]);

      // Si se aprobó, activar el servicio
      if (approved && payment.client_service_id) {
        // Intentar extraer planType de notas antiguas si existen
        // Formato esperado: "Plan: basic. Ref: ..."
        let planType = null;
        if (payment.notes && payment.notes.startsWith('Plan:')) {
          const match = payment.notes.match(/Plan:\s*(\w+)/);
          if (match) planType = match[1];
        }

        await client.query(`
          UPDATE client_services
          SET status = $1, 
              subscription_started_at = CURRENT_TIMESTAMP, 
              subscription_ends_at = CURRENT_TIMESTAMP + INTERVAL '30 days', 
              plan_type = COALESCE($2, plan_type),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `, [SERVICE_STATUS.ACTIVE, planType, payment.client_service_id]);
      }
    });

    // Si se aprobó, enviar email de confirmación
    if (approved) {
      const clientInfo = await query(`
        SELECT c.email, c.name, s.name as service_name
        FROM clients c
        JOIN client_services cs ON c.id = cs.client_id
        JOIN services s ON cs.service_id = s.id
        WHERE cs.id = $1
      `, [payment.client_service_id]);

      if (clientInfo.rows.length > 0) {
        const { email, name, service_name } = clientInfo.rows[0];
        sendPaymentConfirmedEmail(email, name, service_name, payment.amount);
      }
    }

    res.json({
      success: true,
      message: approved ? 'Pago aprobado exitosamente' : 'Pago rechazado'
    });

  } catch (error) {
    console.error('Error en validatePayment:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== GESTIÓN DE TRIALS ====================

const getTrials = async (req, res) => {
  try {
    const { status } = req.query; // active, expiring, expired

    let whereClause = "WHERE cs.status = 'trial'";

    if (status === 'expiring') {
      whereClause += " AND cs.trial_ends_at <= CURRENT_TIMESTAMP + INTERVAL '2 days' AND cs.trial_ends_at > CURRENT_TIMESTAMP";
    } else if (status === 'expired') {
      whereClause += ' AND cs.trial_ends_at <= CURRENT_TIMESTAMP';
    } else if (status === 'active') {
      whereClause += ' AND cs.trial_ends_at > CURRENT_TIMESTAMP';
    }

    const trialsResult = await query(`
      SELECT cs.*, c.name as client_name, c.email as client_email,
             s.name as service_name, s.code as service_code,
             -- calcular días restantes desde la fecha de fin del trial
             GREATEST(0, EXTRACT(DAY FROM (cs.trial_ends_at - CURRENT_TIMESTAMP))) as days_remaining
      FROM client_services cs
      JOIN clients c ON cs.client_id = c.id
      JOIN services s ON cs.service_id = s.id
      ${whereClause}
      ORDER BY cs.trial_ends_at ASC
    `);

    res.json({
      success: true,
      data: {
        trials: trialsResult.rows
      }
    });

  } catch (error) {
    console.error('Error en getTrials:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const extendTrial = async (req, res) => {
  try {
    const { id } = req.params;
    const { days = 5 } = req.body;

    await query(`
      UPDATE client_services
      SET trial_ends_at = trial_ends_at + (($2 || ' days')::INTERVAL),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'trial'
    `, [id, parseInt(days)]);

    res.json({
      success: true,
      message: `Trial extendido por ${days} días`
    });

  } catch (error) {
    console.error('Error en extendTrial:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== SERVICIOS DISPONIBLES ====================

const getServices = async (req, res) => {
  try {
    const result = await query('SELECT * FROM services ORDER BY price_monthly ASC');

    res.json({
      success: true,
      data: {
        services: result.rows
      }
    });

  } catch (error) {
    console.error('Error en getServices:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, priceMonthly, isActive } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (description) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (priceMonthly !== undefined) {
      updates.push(`price_monthly = $${paramIndex++}`);
      values.push(priceMonthly);
    }
    if (req.body.priceBasic !== undefined) {
      updates.push(`price_basic = $${paramIndex++}`);
      values.push(req.body.priceBasic);
    }
    if (req.body.featuresBasic !== undefined) {
      updates.push(`features_basic = $${paramIndex++}`);
      values.push(JSON.stringify(req.body.featuresBasic));
    }
    if (req.body.featuresPro !== undefined) {
      updates.push(`features_pro = $${paramIndex++}`);
      values.push(JSON.stringify(req.body.featuresPro));
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    values.push(id);

    await query(
      `UPDATE services SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    res.json({
      success: true,
      message: 'Servicio actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error en updateService:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== CONFIGURACIÓN DEL SISTEMA ====================

const getBankDetails = async (req, res) => {
  try {
    const result = await query(`
      SELECT value FROM system_config WHERE key = 'bank_details'
    `);

    res.json({
      success: true,
      data: {
        bankDetails: result.rows.length > 0 ? JSON.parse(result.rows[0].value) : null
      }
    });

  } catch (error) {
    console.error('Error en getBankDetails:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateBankDetails = async (req, res) => {
  try {
    const { bank_name, account_holder, account_number, account_type, routing_number, swift, reference_instructions } = req.body;

    if (!bank_name || !account_holder || !account_number) {
      return res.status(400).json({
        success: false,
        error: 'Nombre del banco, titular y número de cuenta son requeridos'
      });
    }

    const bankDetails = JSON.stringify({
      bank_name,
      account_holder,
      account_number,
      account_type: account_type || 'Ahorros',
      routing_number: routing_number || null,
      swift: swift || null,
      reference_instructions: reference_instructions || 'Incluye tu email como referencia de la transferencia'
    });

    // Verificar si existe
    const existingResult = await query(`
      SELECT id FROM system_config WHERE key = 'bank_details'
    `);

    const adminId = req.user.id === 'admin-env' ? null : req.user.id;

    if (existingResult.rows.length > 0) {
      await query(`
        UPDATE system_config
        SET value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
        WHERE key = 'bank_details'
      `, [bankDetails, adminId]);
    } else {
      await query(`
        INSERT INTO system_config (key, value, created_by)
        VALUES ('bank_details', $1, $2)
      `, [bankDetails, adminId]);
    }

    res.json({
      success: true,
      message: 'Datos bancarios actualizados exitosamente'
    });

  } catch (error) {
    console.error('Error en updateBankDetails:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getSystemConfig = async (req, res) => {
  try {
    const result = await query('SELECT key, value FROM system_config');

    const config = {};
    result.rows.forEach(row => {
      try {
        config[row.key] = JSON.parse(row.value);
      } catch {
        config[row.key] = row.value;
      }
    });

    res.json({
      success: true,
      data: { config }
    });

  } catch (error) {
    console.error('Error en getSystemConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== CONFIGURACIÓN DE META API ====================

const getMetaConfig = async (req, res) => {
  try {
    const result = await query(`
      SELECT value FROM system_config WHERE key = 'meta_api_config'
    `);

    res.json({
      success: true,
      data: result.rows.length > 0 ? JSON.parse(result.rows[0].value) : {
        meta_app_id: '',
        meta_app_secret: '',
        meta_verify_token: '',
        whatsapp_business_account_id: '',
        whatsapp_access_token: '',
        messenger_page_id: '',
        messenger_page_access_token: '',
        instagram_account_id: '',
        instagram_access_token: ''
      }
    });

  } catch (error) {
    console.error('Error en getMetaConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateMetaConfig = async (req, res) => {
  try {
    const {
      meta_app_id,
      meta_app_secret,
      meta_verify_token,
      whatsapp_business_account_id,
      whatsapp_access_token,
      messenger_page_id,
      messenger_page_access_token,
      instagram_account_id,
      instagram_access_token
    } = req.body;

    if (!meta_app_id || !meta_app_secret || !meta_verify_token) {
      return res.status(400).json({
        success: false,
        error: 'Meta App ID, App Secret y Verify Token son requeridos'
      });
    }

    const metaConfig = JSON.stringify({
      meta_app_id,
      meta_app_secret,
      meta_verify_token,
      whatsapp_business_account_id: whatsapp_business_account_id || '',
      whatsapp_access_token: whatsapp_access_token || '',
      messenger_page_id: messenger_page_id || '',
      messenger_page_access_token: messenger_page_access_token || '',
      instagram_account_id: instagram_account_id || '',
      instagram_access_token: instagram_access_token || ''
    });

    // Verificar si existe
    const existingResult = await query(`
      SELECT id FROM system_config WHERE key = 'meta_api_config'
    `);

    const adminId = req.user.id === 'admin-env' ? null : req.user.id;

    if (existingResult.rows.length > 0) {
      await query(`
        UPDATE system_config
        SET value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
        WHERE key = 'meta_api_config'
      `, [metaConfig, adminId]);
    } else {
      await query(`
        INSERT INTO system_config (key, value, created_by)
        VALUES ('meta_api_config', $1, $2)
      `, [metaConfig, adminId]);
    }

    res.json({
      success: true,
      message: 'Configuración de Meta API guardada exitosamente'
    });

  } catch (error) {
    console.error('Error en updateMetaConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const testMetaConnection = async (req, res) => {
  try {
    // Obtener configuración
    const configResult = await query(`
      SELECT value FROM system_config WHERE key = 'meta_api_config'
    `);

    if (configResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No se ha configurado Meta API aún'
      });
    }

    const config = JSON.parse(configResult.rows[0].value);

    if (!config.whatsapp_access_token) {
      return res.status(400).json({
        success: false,
        error: 'Token de acceso de WhatsApp no configurado'
      });
    }

    // Probar conexión con la API de WhatsApp
    const axios = require('axios');
    const response = await axios.get(
      `https://graph.facebook.com/v21.0/${config.whatsapp_business_account_id}`,
      {
        headers: {
          'Authorization': `Bearer ${config.whatsapp_access_token}`
        }
      }
    );

    if (response.data && response.data.id) {
      res.json({
        success: true,
        message: 'Conexión exitosa con Meta API',
        data: {
          business_account_id: response.data.id,
          name: response.data.name
        }
      });
    } else {
      throw new Error('Respuesta inválida de Meta API');
    }

  } catch (error) {
    console.error('Error en testMetaConnection:', error);

    let errorMessage = 'Error al conectar con Meta API';
    if (error.response) {
      errorMessage = error.response.data?.error?.message || errorMessage;
    }

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
};

// ==================== CONFIGURACIÓN DE TELEGRAM ====================

const getTelegramConfig = async (req, res) => {
  try {
    const result = await query(`
      SELECT value FROM system_config WHERE key = 'telegram_config'
    `);

    const defaultConfig = {
      bot_token: '',
      bot_username: '',
      webhook_url: ''
    };

    res.json({
      success: true,
      data: result.rows.length > 0 ? JSON.parse(result.rows[0].value) : defaultConfig
    });

  } catch (error) {
    console.error('Error en getTelegramConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateTelegramConfig = async (req, res) => {
  try {
    const { bot_token, bot_username, webhook_url } = req.body;

    const telegramConfig = JSON.stringify({
      bot_token,
      bot_username: bot_username || '',
      webhook_url: webhook_url || ''
    });

    // Verificar si existe
    const existingResult = await query(`
      SELECT id FROM system_config WHERE key = 'telegram_config'
    `);

    const adminId = req.user.id === 'admin-env' ? null : req.user.id;

    if (existingResult.rows.length > 0) {
      await query(`
        UPDATE system_config
        SET value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
        WHERE key = 'telegram_config'
      `, [telegramConfig, adminId]);
    } else {
      await query(`
        INSERT INTO system_config (key, value, created_by)
        VALUES ('telegram_config', $1, $2)
      `, [telegramConfig, adminId]);
    }

    res.json({
      success: true,
      message: 'Configuración de Telegram guardada exitosamente'
    });

  } catch (error) {
    console.error('Error en updateTelegramConfig:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const testTelegramConnection = async (req, res) => {
  try {
    const configResult = await query(`
      SELECT value FROM system_config WHERE key = 'telegram_config'
    `);

    if (configResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Configuración de Telegram no encontrada'
      });
    }

    const config = JSON.parse(configResult.rows[0].value);

    if (!config.bot_token) {
      return res.status(400).json({
        success: false,
        error: 'Bot token no configurado'
      });
    }

    const telegramService = require('../services/telegramService');
    const botInfo = await telegramService.getBotInfo(config.bot_token);

    if (botInfo.success) {
      res.json({
        success: true,
        message: 'Conexión exitosa con Telegram',
        data: {
          bot: botInfo.bot
        }
      });
    } else {
      throw new Error('No se pudo obtener información del bot');
    }

  } catch (error) {
    console.error('Error en testTelegramConnection:', error);

    let errorMessage = 'Error al conectar con Telegram';
    if (error.response) {
      errorMessage = error.response.data?.description || errorMessage;
    }

    res.status(400).json({
      success: false,
      error: errorMessage
    });
  }
};

// =====================================================
// PROVEEDOR DE MENSAJERÍA (meta | bird)
// =====================================================
const getMessagingProvider = async (req, res) => {
  try {
    const result = await query(`
      SELECT value FROM system_config WHERE key = 'messaging_provider'
    `);
    const provider = result.rows.length > 0
      ? JSON.parse(result.rows[0].value)
      : 'meta';
    res.json({ success: true, data: { provider } });
  } catch (error) {
    console.error('Error en getMessagingProvider:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const updateMessagingProvider = async (req, res) => {
  try {
    const { provider } = req.body;
    if (!['meta', 'bird'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'provider debe ser "meta" o "bird"' });
    }

    const value = JSON.stringify(provider);
    // admin-env no tiene UUID real — usar null para columnas updated_by/created_by
    const userId = req.user.id === 'admin-env' ? null : req.user.id;
    const existing = await query(`SELECT id FROM system_config WHERE key = 'messaging_provider'`);

    if (existing.rows.length > 0) {
      await query(`
        UPDATE system_config SET value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
        WHERE key = 'messaging_provider'
      `, [value, userId]);
    } else {
      await query(`
        INSERT INTO system_config (key, value, created_by)
        VALUES ('messaging_provider', $1, $2)
      `, [value, userId]);
    }

    res.json({ success: true, message: `Proveedor cambiado a "${provider}" exitosamente` });
  } catch (error) {
    console.error('Error en updateMessagingProvider:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// CRON JOBS - Ejecución manual desde admin panel
// =====================================================
const { runJobManually } = require('../jobs');

const runCronJob = async (req, res) => {
  try {
    const { jobName } = req.params;
    const result = await runJobManually(jobName);
    res.json({
      success: true,
      message: `Job "${jobName}" ejecutado exitosamente`,
      data: result
    });
  } catch (error) {
    console.error('Error ejecutando job manual:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// ==================== PEDIDOS (ADMIN) ====================

const getAllOrders = async (req, res) => {
  try {
    const { status, clientId, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT
        o.id, o.conversation_id, o.client_id, o.total_amount, o.currency,
        o.status, o.voucher_url, o.items, o.shipping_info, o.notes,
        o.created_at, o.updated_at,
        c.name as client_name, c.email as client_email,
        b.name as business_name
      FROM orders o
      LEFT JOIN clients c ON c.id = o.client_id
      LEFT JOIN businesses b ON b.client_id = o.client_id
    `;
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    }
    if (clientId) {
      conditions.push(`o.client_id = $${params.length + 1}`);
      params.push(clientId);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Total count
    let countSql = 'SELECT COUNT(*) FROM orders o';
    if (conditions.length > 0) {
      countSql += ' WHERE ' + conditions.join(' AND ');
    }
    const countResult = await query(countSql, params.slice(0, -2));

    res.json({
      success: true,
      data: {
        orders: result.rows,
        total: parseInt(countResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Error en getAllOrders:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const adminUpdateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'paid_voucher', 'approved', 'completed', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Estado no válido' });
    }

    const result = await query(`
      UPDATE orders
      SET status = $1, notes = COALESCE($2, notes), updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [status, notes, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error en adminUpdateOrderStatus:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

/**
 * Conectar número de prueba de WhatsApp manualmente (solo admin / dev)
 * POST /admin/test/connect-whatsapp
 * Body: { clientServiceId, phoneNumberId, wabaId, accessToken, displayPhone, verifiedName }
 */
const testConnectWhatsApp = async (req, res) => {
  try {
    const { clientServiceId, phoneNumberId, wabaId, accessToken, displayPhone, verifiedName } = req.body;

    if (!clientServiceId || !phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos requeridos: clientServiceId, phoneNumberId, wabaId, accessToken'
      });
    }

    // Verificar que el client_service existe y es de WhatsApp
    const svcResult = await query(`
      SELECT cs.id, s.code FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.id = $1
    `, [clientServiceId]);

    if (svcResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'client_service no encontrado' });
    }

    if (svcResult.rows[0].code !== 'whatsapp') {
      return res.status(400).json({ success: false, error: 'El servicio no es de tipo WhatsApp' });
    }

    const credentials = {
      whatsapp_access_token: accessToken,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      display_phone: displayPhone || '+1 555 TEST',
      verified_name: verifiedName || 'Test Business',
    };

    // Usa el mismo método que el flujo OAuth real
    await metaOAuth.saveClientCredentials(clientServiceId, credentials, 86400); // 24h (token de prueba)

    res.json({
      success: true,
      message: 'Número de prueba conectado correctamente',
      data: { clientServiceId, phoneNumberId, wabaId }
    });
  } catch (error) {
    console.error('Error en testConnectWhatsApp:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /admin/fix-platform-credential
 * Actualiza un campo específico dentro de platform_credentials en client_services
 * Útil para corregir instagram_account_id cuando no coincide con el webhook
 * Body: { clientServiceId, field, value }
 * Ejemplo: { clientServiceId: "uuid...", field: "instagram_account_id", value: "17841405837710779" }
 */
const fixPlatformCredential = async (req, res) => {
  try {
    const { clientServiceId, field, value } = req.body;

    if (!clientServiceId || !field || value === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Requeridos: clientServiceId, field, value'
      });
    }

    // Verificar que el campo sea uno permitido (seguridad)
    const allowedFields = [
      'instagram_account_id', 'instagram_username',
      'page_id', 'page_name',
      'phone_number_id', 'display_phone', 'verified_name',
      'waba_id', 'waba_name'
    ];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({
        success: false,
        error: `Campo no permitido. Campos válidos: ${allowedFields.join(', ')}`
      });
    }

    // Leer config actual
    const svcResult = await query(
      'SELECT id, config FROM client_services WHERE id = $1',
      [clientServiceId]
    );

    if (svcResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'client_service no encontrado' });
    }

    const currentConfig = svcResult.rows[0].config || {};
    const updatedConfig = {
      ...currentConfig,
      platform_credentials: {
        ...(currentConfig.platform_credentials || {}),
        [field]: value
      }
    };

    await query(
      'UPDATE client_services SET config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(updatedConfig), clientServiceId]
    );

    res.json({
      success: true,
      message: `Campo '${field}' actualizado a '${value}' para el servicio ${clientServiceId}`
    });

  } catch (error) {
    console.error('Error en fixPlatformCredential:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==================== BILLING (PAYG) ====================

const getBillingOverview = async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);

    const summary = await getAllClientsUsageSummary(year, month);

    res.json({ success: true, data: { year, month, clients: summary } });
  } catch (error) {
    console.error('Error en getBillingOverview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const addClientCredits = async (req, res) => {
  try {
    const { clientServiceId } = req.params;
    const { amount, notes } = req.body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Monto inválido' });
    }

    const { newBalance } = await addCredits(clientServiceId, parseFloat(amount), notes || '');

    res.json({
      success: true,
      message: `Se agregaron $${parseFloat(amount).toFixed(2)} créditos`,
      data: { newBalance }
    });
  } catch (error) {
    console.error('Error en addClientCredits:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const getClientBillingDetail = async (req, res) => {
  try {
    const { clientId } = req.params;
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);

    const usage = await getMonthlyUsage(clientId, year, month);

    // Get balance for all PAYG services
    const servicesResult = await query(
      `SELECT id, credit_balance, plan_type FROM client_services WHERE client_id = $1`,
      [clientId]
    );

    res.json({
      success: true,
      data: { year, month, usage, services: servicesResult.rows }
    });
  } catch (error) {
    console.error('Error en getClientBillingDetail:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// =====================================================
// UPDATE PAYG PRICING PER SERVICE
// =====================================================

/**
 * PUT /admin/billing/payg-pricing/:clientServiceId
 * Sets custom per-token pricing for a PAYG service.
 * If no custom pricing is provided, removes override (falls back to global defaults).
 */
const updateServicePaygPricing = async (req, res) => {
  try {
    const { clientServiceId } = req.params;
    const { input_price_per_1k, output_price_per_1k } = req.body;

    if (input_price_per_1k === undefined || output_price_per_1k === undefined) {
      return res.status(400).json({
        success: false,
        error: 'input_price_per_1k y output_price_per_1k son requeridos'
      });
    }

    const inputRate  = parseFloat(input_price_per_1k);
    const outputRate = parseFloat(output_price_per_1k);

    if (isNaN(inputRate) || isNaN(outputRate) || inputRate <= 0 || outputRate <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Los precios deben ser números positivos'
      });
    }

    const paygPricing = { input_price_per_1k: inputRate, output_price_per_1k: outputRate };

    const result = await query(
      `UPDATE client_services
       SET config = jsonb_set(COALESCE(config, '{}'), '{payg_pricing}', $1::jsonb),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, plan_type, config->>'payg_pricing' AS payg_pricing`,
      [JSON.stringify(paygPricing), clientServiceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    res.json({
      success: true,
      message: 'Precio PAYG actualizado correctamente',
      data: { clientServiceId, paygPricing }
    });
  } catch (error) {
    console.error('Error en updateServicePaygPricing:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ==================== VOZ IA — SOLICITUDES ====================

/**
 * Lista todas las solicitudes de voz (pending / active / rejected)
 */
const getVoiceRequests = async (req, res) => {
  try {
    const { status = 'all' } = req.query;

    let whereClause = `WHERE cs.config->'voice_config' IS NOT NULL
      AND cs.config->'voice_config'->>'whatsapp_phone' != ''`;

    if (status !== 'all') {
      whereClause += ` AND cs.config->'voice_config'->>'voice_status' = '${status}'`;
    }

    const result = await query(`
      SELECT
        cs.id                                                        AS client_service_id,
        cs.plan_type,
        cs.config->'voice_config'                                    AS voice_config,
        cs.config->'voice_config'->>'whatsapp_phone'                 AS whatsapp_phone,
        cs.config->'voice_config'->>'voice_status'                   AS voice_status,
        cs.config->'voice_config'->>'transfer_phone'                 AS transfer_phone,
        cs.config->'voice_config'->>'transfer_phone_backup'          AS transfer_phone_backup,
        cs.config->'voice_config'->>'voice'                          AS voice,
        cs.config->'voice_config'->>'language'                       AS language,
        (cs.config->'voice_config'->>'max_duration_seconds')::int    AS max_duration_seconds,
        cs.config->'voice_config'->>'welcome_message'                AS welcome_message,
        cs.updated_at,
        c.id                                                         AS client_id,
        c.name                                                       AS client_name,
        c.email                                                      AS client_email,
        b.name                                                       AS business_name
      FROM client_services cs
      JOIN clients c ON c.id = cs.client_id
      LEFT JOIN businesses b ON b.client_id = cs.client_id
      ${whereClause}
      ORDER BY cs.updated_at DESC
    `);

    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[getVoiceRequests] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al obtener solicitudes de voz' });
  }
};

/**
 * Activa el número de voz de un cliente (después de registrarlo en Voximplant)
 */
const activateVoiceNumber = async (req, res) => {
  try {
    const { clientServiceId } = req.params;

    // Obtener info del cliente para enviar email
    const serviceResult = await query(`
      SELECT cs.config, c.name AS client_name, c.email AS client_email,
             cs.config->'voice_config'->>'whatsapp_phone' AS whatsapp_phone
      FROM client_services cs
      JOIN clients c ON c.id = cs.client_id
      WHERE cs.id = $1
    `, [clientServiceId]);

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const row = serviceResult.rows[0];

    // Actualizar voice_status a 'active' y enabled = true
    await query(`
      UPDATE client_services
      SET config = jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(config, '{}'), '{voice_config,voice_status}', '"active"'),
              '{voice_config,enabled}', 'true'
            ),
            '{voice_config,activated_at}', to_jsonb(NOW()::text)
          ),
          updated_at = NOW()
      WHERE id = $1
    `, [clientServiceId]);

    // Notificar al cliente por email
    if (row.client_email && row.whatsapp_phone) {
      setImmediate(() => {
        sendVoiceActivatedEmail(row.client_email, {
          clientName: row.client_name,
          whatsappPhone: row.whatsapp_phone,
        }).catch(() => {});
      });
    }

    console.log(`✅ [Admin] Voz activada para servicio ${clientServiceId} — ${row.whatsapp_phone}`);
    return res.json({ success: true, message: `Número ${row.whatsapp_phone} activado correctamente` });
  } catch (err) {
    console.error('[activateVoiceNumber] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al activar el número' });
  }
};

/**
 * Rechaza / desactiva un número de voz
 */
const rejectVoiceNumber = async (req, res) => {
  try {
    const { clientServiceId } = req.params;
    const { reason = '' } = req.body;

    await query(`
      UPDATE client_services
      SET config = jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(config, '{}'), '{voice_config,voice_status}', '"rejected"'),
              '{voice_config,enabled}', 'false'
            ),
            '{voice_config,reject_reason}', to_jsonb($2::text)
          ),
          updated_at = NOW()
      WHERE id = $1
    `, [clientServiceId, reason]);

    return res.json({ success: true, message: 'Solicitud rechazada' });
  } catch (err) {
    console.error('[rejectVoiceNumber] Error:', err);
    return res.status(500).json({ success: false, error: 'Error al rechazar la solicitud' });
  }
};

module.exports = {
  getDashboard,
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  assignService,
  updateClientService,
  deleteClientService,
  getPayments,
  validatePayment,
  getTrials,
  extendTrial,
  // createTrial omitted as admin can use assignService with planType='trial'
  getServices,
  updateService,
  // Configuración del sistema
  getBankDetails,
  updateBankDetails,
  getSystemConfig,
  // Configuración de Meta API
  getMetaConfig,
  updateMetaConfig,
  testMetaConnection,
  // Configuración de Telegram
  getTelegramConfig,
  updateTelegramConfig,
  testTelegramConnection,
  // Proveedor de mensajería
  getMessagingProvider,
  updateMessagingProvider,
  // CRON Jobs
  runCronJob,
  // Pedidos
  getAllOrders,
  adminUpdateOrderStatus,
  // DEV / TEST
  testConnectWhatsApp,
  fixPlatformCredential,
  // Billing PAYG
  getBillingOverview,
  addClientCredits,
  getClientBillingDetail,
  updateServicePaygPricing,
  // Voz IA
  getVoiceRequests,
  activateVoiceNumber,
  rejectVoiceNumber,
};
