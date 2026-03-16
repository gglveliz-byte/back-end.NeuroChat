const { query, transaction } = require('../config/database');
const { hashPassword, comparePassword, generatePaymentReference } = require('../utils/hash');
const { SERVICE_STATUS, PAYMENT_STATUS, PAYMENT_METHODS, TRIAL, PAYG } = require('../config/constants');
const paypalService = require('../services/paypalService');
const path = require('path');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { indexKnowledgeFile } = require('../services/embeddingService');
const { getMonthlyUsage, getDailyUsage, checkBalance } = require('../services/billingService');

// ==================== PERFIL ====================

const getProfile = async (req, res) => {
  try {
    const clientResult = await query(`
      SELECT c.id, c.email, c.name, c.phone, c.status, c.email_verified, c.created_at
      FROM clients c
      WHERE c.id = $1
    `, [req.user.id]);

    const businessResult = await query(`
      SELECT * FROM businesses WHERE client_id = $1
    `, [req.user.id]);

    res.json({
      success: true,
      data: {
        profile: clientResult.rows[0],
        business: businessResult.rows[0] || null
      }
    });

  } catch (error) {
    console.error('Error en getProfile:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { name, phone } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone || null);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(req.user.id);

      await query(
        `UPDATE clients SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }

    res.json({
      success: true,
      message: 'Perfil actualizado exitosamente'
    });

  } catch (error) {
    console.error('Error en updateProfile:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Contraseña actual y nueva son requeridas'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La nueva contraseña debe tener al menos 8 caracteres'
      });
    }

    // Verificar contraseña actual
    const clientResult = await query('SELECT password_hash FROM clients WHERE id = $1', [req.user.id]);
    const isValid = await comparePassword(currentPassword, clientResult.rows[0].password_hash);

    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'Contraseña actual incorrecta'
      });
    }

    // Actualizar contraseña
    const newHash = await hashPassword(newPassword);
    await query(
      'UPDATE clients SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({
      success: true,
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error en changePassword:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== NEGOCIO ====================

const getBusiness = async (req, res) => {
  try {
    const result = await query('SELECT * FROM businesses WHERE client_id = $1', [req.user.id]);

    res.json({
      success: true,
      data: {
        business: result.rows[0] || null
      }
    });

  } catch (error) {
    console.error('Error en getBusiness:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const updateBusiness = async (req, res) => {
  try {
    const { name, industry, description, store_description, country, address, website, phone, email, business_hours, payment_config } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'El nombre del negocio es requerido'
      });
    }

    // Verificar si ya existe
    const existingResult = await query('SELECT id FROM businesses WHERE client_id = $1', [req.user.id]);

    if (existingResult.rows.length > 0) {
      await query(`
        UPDATE businesses
        SET name = $1, industry = $2, description = $3, country = $4, address = $5, website = $6,
            phone = $7, email = $8, business_hours = $9, payment_config = $10,
            store_description = $11,
            updated_at = CURRENT_TIMESTAMP
        WHERE client_id = $12
      `, [
        name, industry, description, country, address, website, phone, email,
        JSON.stringify(business_hours || {}),
        JSON.stringify(payment_config || {}),
        store_description || null,
        req.user.id
      ]);
    } else {
      const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + req.user.id.substring(0, 5)).toLowerCase();

      await query(`
        INSERT INTO businesses (client_id, name, industry, description, store_description, country, address, website, phone, email, slug, business_hours, payment_config)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        req.user.id, name, industry, description, store_description || null, country, address, website, phone, email, slug,
        JSON.stringify(business_hours || {}),
        JSON.stringify(payment_config || {})
      ]);
    }

    res.json({
      success: true,
      message: 'Información del negocio actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error en updateBusiness:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ── Upload logo del negocio ──────────────────────────────
const uploadBusinessLogo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió imagen' });
    const fileUrl = `/uploads/${req.file.filename}`;
    await query(
      'UPDATE businesses SET logo_url = $1, updated_at = CURRENT_TIMESTAMP WHERE client_id = $2',
      [fileUrl, req.user.id]
    );
    res.json({ success: true, url: fileUrl });
  } catch (error) {
    console.error('Error en uploadBusinessLogo:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ── Upload banner del negocio ────────────────────────────
const uploadBusinessBanner = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No se recibió imagen' });
    const fileUrl = `/uploads/${req.file.filename}`;
    await query(
      'UPDATE businesses SET banner_url = $1, updated_at = CURRENT_TIMESTAMP WHERE client_id = $2',
      [fileUrl, req.user.id]
    );
    res.json({ success: true, url: fileUrl });
  } catch (error) {
    console.error('Error en uploadBusinessBanner:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ==================== SERVICIOS ====================

const getMyServices = async (req, res) => {
  try {
    // Obtener todos los servicios disponibles
    const allServicesResult = await query('SELECT * FROM services WHERE is_active = true ORDER BY price_monthly ASC');

    // Obtener servicios contratados
    const myServicesResult = await query(`
      SELECT cs.*, s.name, s.code, s.icon, s.color, s.price_monthly, s.description
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
    `, [req.user.id]);

    // Crear mapa de servicios contratados
    const contractedServices = {};
    myServicesResult.rows.forEach(s => {
      contractedServices[s.service_id] = s;
    });

    // Combinar información
    const services = allServicesResult.rows.map(service => ({
      ...service,
      contracted: !!contractedServices[service.id],
      contractInfo: contractedServices[service.id] || null
    }));

    res.json({
      success: true,
      data: {
        services,
        contractedCount: myServicesResult.rows.length
      }
    });

  } catch (error) {
    console.error('Error en getMyServices:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getServiceDetail = async (req, res) => {
  try {
    const { code } = req.params;

    const serviceResult = await query(`
      SELECT cs.*, s.name, s.code, s.icon, s.color, s.price_monthly, s.description,
             bc.welcome_message, bc.away_message, bc.fallback_message, bc.personality,
             bc.language, bc.knowledge_base, bc.business_hours, bc.ai_config
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      LEFT JOIN bot_configs bc ON cs.id = bc.client_service_id
      WHERE cs.client_id = $1 AND s.code = $2
    `, [req.user.id, code]);

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No tienes este servicio contratado'
      });
    }

    res.json({
      success: true,
      data: {
        service: serviceResult.rows[0]
      }
    });

  } catch (error) {
    console.error('Error en getServiceDetail:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const activateTrial = async (req, res) => {
  try {
    const { serviceId, planType } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio requerido'
      });
    }

    // Verificar que el servicio existe
    const serviceResult = await query('SELECT * FROM services WHERE id = $1 AND is_active = true', [serviceId]);
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no disponible'
      });
    }

    // Verificar si ya tiene el servicio
    const existingResult = await query(
      'SELECT * FROM client_services WHERE client_id = $1 AND service_id = $2',
      [req.user.id, serviceId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Ya tienes este servicio. Si está inactivo, realiza un pago para activarlo.'
      });
    }

    // Verificar datos del negocio
    const businessResult = await query('SELECT id FROM businesses WHERE client_id = $1', [req.user.id]);
    if (businessResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Debes completar los datos de tu negocio antes de activar un servicio'
      });
    }

    // Calcular fechas de trial
    const trialStartedAt = new Date();
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL.DURATION_DAYS);

    const result = await transaction(async (client) => {
      // Crear servicio con trial
      const csResult = await client.query(`
        INSERT INTO client_services (client_id, service_id, status, trial_started_at, trial_ends_at, plan_type)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [req.user.id, serviceId, SERVICE_STATUS.TRIAL, trialStartedAt, trialEndsAt, planType || 'pro']);

      const clientService = csResult.rows[0];

      // Crear configuración de bot
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
      message: `¡Trial activado! Tienes ${TRIAL.DURATION_DAYS} días para probar el servicio.`,
      data: {
        clientService: result,
        service: serviceResult.rows[0],
        trialEndsAt
      }
    });

  } catch (error) {
    console.error('Error en activateTrial:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const cancelService = async (req, res) => {
  try {
    const { clientServiceId } = req.body;

    if (!clientServiceId) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio requerido'
      });
    }

    // Verificar que el servicio pertenece al cliente
    const result = await query(`
      UPDATE client_services
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND client_id = $2
      RETURNING *
    `, [clientServiceId, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    res.json({
      success: true,
      message: 'Servicio cancelado correctamente'
    });

  } catch (error) {
    console.error('Error en cancelService:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== PAGOS ====================

const getMyPayments = async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, s.name as service_name, s.code as service_code
      FROM payments p
      LEFT JOIN client_services cs ON p.client_service_id = cs.id
      LEFT JOIN services s ON cs.service_id = s.id
      WHERE p.client_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      data: {
        payments: result.rows
      }
    });

  } catch (error) {
    console.error('Error en getMyPayments:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const createPayment = async (req, res) => {
  try {
    const { serviceId, method } = req.body;

    if (!serviceId || !method) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio y método de pago son requeridos'
      });
    }

    if (!Object.values(PAYMENT_METHODS).includes(method)) {
      return res.status(400).json({
        success: false,
        error: 'Método de pago no válido'
      });
    }

    // Obtener servicio del cliente
    const csResult = await query(`
      SELECT cs.*, s.price_monthly, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND cs.service_id = $2
    `, [req.user.id, serviceId]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No tienes este servicio'
      });
    }

    const clientService = csResult.rows[0];

    // Crear pago
    const reference = generatePaymentReference();
    const result = await query(`
      INSERT INTO payments (client_id, client_service_id, amount, method, reference, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.user.id, clientService.id, clientService.price_monthly, method, reference, PAYMENT_STATUS.PENDING]);

    const payment = result.rows[0];

    // Si es transferencia, devolver datos bancarios desde variables de entorno
    let paymentInfo = {};
    if (method === PAYMENT_METHODS.TRANSFER) {
      paymentInfo = {
        bank: process.env.BANK_NAME || 'No configurado',
        accountNumber: process.env.BANK_ACCOUNT_NUMBER || 'No configurado',
        accountHolder: process.env.BANK_ACCOUNT_HOLDER || 'No configurado',
        reference: reference,
        amount: clientService.price_monthly,
        message: 'Sube el comprobante de pago una vez realizada la transferencia'
      };
    }

    res.status(201).json({
      success: true,
      message: 'Pago creado. Completa el proceso según el método seleccionado.',
      data: {
        payment,
        paymentInfo,
        service: {
          name: clientService.service_name,
          price: clientService.price_monthly
        }
      }
    });

  } catch (error) {
    console.error('Error en createPayment:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const uploadReceipt = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { receiptUrl } = req.body;

    if (!receiptUrl) {
      return res.status(400).json({
        success: false,
        error: 'URL del comprobante requerida'
      });
    }

    // Verificar que el pago existe y es del cliente
    const paymentResult = await query(
      'SELECT * FROM payments WHERE id = $1 AND client_id = $2',
      [paymentId, req.user.id]
    );

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

    // Actualizar con comprobante
    await query(
      'UPDATE payments SET receipt_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [receiptUrl, paymentId]
    );

    res.json({
      success: true,
      message: 'Comprobante subido. El administrador verificará tu pago pronto.'
    });

  } catch (error) {
    console.error('Error en uploadReceipt:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== SUSCRIPCIÓN ====================

const getSubscriptionStatus = async (req, res) => {
  try {
    const servicesResult = await query(`
      SELECT cs.*, s.name, s.code, s.price_monthly,
             CASE
               WHEN cs.status = 'trial' AND cs.trial_ends_at > CURRENT_TIMESTAMP THEN 'trial_active'
               WHEN cs.status = 'trial' AND cs.trial_ends_at <= CURRENT_TIMESTAMP THEN 'trial_expired'
               WHEN cs.status = 'active' AND cs.subscription_ends_at > CURRENT_TIMESTAMP THEN 'active'
               WHEN cs.status = 'active' AND cs.subscription_ends_at <= CURRENT_TIMESTAMP THEN 'expired'
               ELSE cs.status
             END as current_status,
             CASE
               WHEN cs.status = 'trial' THEN EXTRACT(DAY FROM (cs.trial_ends_at - CURRENT_TIMESTAMP))
               ELSE EXTRACT(DAY FROM (cs.subscription_ends_at - CURRENT_TIMESTAMP))
             END as days_remaining
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
    `, [req.user.id]);

    res.json({
      success: true,
      data: {
        subscriptions: servicesResult.rows
      }
    });

  } catch (error) {
    console.error('Error en getSubscriptionStatus:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

// ==================== NUEVOS PAGOS ====================

// =====================================================
// Crear suscripción pendiente de pago (sin trial)
// =====================================================
const createPendingSubscription = async (req, res) => {
  try {
    const { serviceId, planType } = req.body;

    if (!serviceId || !planType) {
      return res.status(400).json({
        success: false,
        error: 'serviceId y planType son requeridos'
      });
    }

    // Verificar que el servicio existe
    const serviceResult = await query('SELECT * FROM services WHERE id = $1 AND is_active = true', [serviceId]);
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Servicio no disponible' });
    }

    // Verificar si ya tiene el servicio
    const existingResult = await query(
      'SELECT * FROM client_services WHERE client_id = $1 AND service_id = $2',
      [req.user.id, serviceId]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      // Si ya está pending_payment, retornar el existente
      if (existing.status === 'pending_payment') {
        return res.json({
          success: true,
          message: 'Suscripción pendiente de pago ya existe',
          data: { clientService: existing }
        });
      }
      return res.status(400).json({
        success: false,
        error: 'Ya tienes este servicio activo o en prueba.'
      });
    }

    // Verificar datos del negocio
    const businessResult = await query('SELECT id FROM businesses WHERE client_id = $1', [req.user.id]);
    if (businessResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Debes completar los datos de tu negocio primero'
      });
    }

    // Crear servicio en estado pending_payment
    const csResult = await query(`
      INSERT INTO client_services (client_id, service_id, status, plan_type)
      VALUES ($1, $2, 'pending_payment', $3)
      RETURNING *
    `, [req.user.id, serviceId, planType]);

    res.status(201).json({
      success: true,
      message: 'Suscripción creada. Procede al pago para activar el servicio.',
      data: { clientService: csResult.rows[0] }
    });

  } catch (error) {
    console.error('Error en createPendingSubscription:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const getServicesToPay = async (req, res) => {
  try {
    // Obtener servicios que necesitan pago:
    // - Trial: siempre mostrar (necesitan upgrade)
    // - Expired: siempre mostrar (necesitan reactivar)
    // - Active: solo si le quedan 5 días o menos (renovación)
    const result = await query(`
      SELECT
        cs.id as client_service_id,
        s.name as service_name,
        s.code as service_code,
        s.price_monthly,
        s.price_basic,
        cs.status,
        CASE
          WHEN cs.status = 'trial' THEN cs.trial_ends_at
          ELSE cs.subscription_ends_at
        END as expires_at,
        CASE
          WHEN cs.status = 'trial' THEN
            GREATEST(0, EXTRACT(DAY FROM (cs.trial_ends_at - CURRENT_TIMESTAMP)))
          ELSE
            GREATEST(0, EXTRACT(DAY FROM (cs.subscription_ends_at - CURRENT_TIMESTAMP)))
        END as days_remaining
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
        AND (
          cs.status IN ('trial', 'expired', 'pending_payment')
          OR (cs.status = 'active' AND cs.subscription_ends_at <= CURRENT_TIMESTAMP + INTERVAL '5 days')
        )
      ORDER BY days_remaining ASC
    `, [req.user.id]);

    res.json({
      success: true,
      data: {
        services: result.rows
      }
    });

  } catch (error) {
    console.error('Error en getServicesToPay:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getPaymentHistory = async (req, res) => {
  try {
    const result = await query(`
      SELECT
        p.id,
        s.name as service_name,
        p.amount,
        p.currency,
        p.method,
        p.status,
        p.reference,
        p.paypal_order_id,
        p.paypal_capture_id,
        p.created_at
      FROM payments p
      LEFT JOIN client_services cs ON p.client_service_id = cs.id
      LEFT JOIN services s ON cs.service_id = s.id
      WHERE p.client_id = $1
      ORDER BY p.created_at DESC
      LIMIT 50
    `, [req.user.id]);

    res.json({
      success: true,
      data: {
        payments: result.rows
      }
    });

  } catch (error) {
    console.error('Error en getPaymentHistory:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
};

const getBankDetails = async (req, res) => {
  try {
    // Obtener configuración de banco del sistema
    const result = await query(`
      SELECT value FROM system_config WHERE key = 'bank_details'
    `);

    if (result.rows.length === 0 || !result.rows[0].value) {
      return res.json({
        success: true,
        data: {
          bankDetails: null
        }
      });
    }

    res.json({
      success: true,
      data: {
        bankDetails: JSON.parse(result.rows[0].value)
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

const createPayPalOrder = async (req, res) => {
  try {
    const { clientServiceId } = req.body;

    if (!clientServiceId) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio requerido'
      });
    }

    // Verificar que el servicio pertenece al cliente
    const csResult = await query(`
      SELECT cs.*, s.price_monthly, s.price_basic, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.id = $1 AND cs.client_id = $2
    `, [clientServiceId, req.user.id]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const clientService = csResult.rows[0];

    // Verificar que el servicio realmente necesita pago
    if (clientService.status === 'active' && clientService.subscription_ends_at) {
      const daysRemaining = Math.ceil((new Date(clientService.subscription_ends_at) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining > 5) {
        return res.status(400).json({
          success: false,
          error: `Tu suscripción está activa hasta ${new Date(clientService.subscription_ends_at).toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' })}. Podrás renovar cuando falten 5 días o menos.`
        });
      }
    }

    // Verificar que PayPal está configurado
    if (!paypalService.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'PayPal no está disponible en este momento'
      });
    }

    // PayPal requiere UNA sola URL. Usar PAYPAL_RETURN_BASE_URL si está definida (ej: dominio propio),
    // sino la primera de FRONTEND_URL (puede tener múltiples para CORS).
    const baseForPayPal = process.env.PAYPAL_RETURN_BASE_URL
      ? process.env.PAYPAL_RETURN_BASE_URL.trim()
      : (process.env.FRONTEND_URL || 'http://localhost:3000').split(/[,\s]+/)[0].trim();

    // Determinar precio y plan
    // Si viene req.body.planType, usamos ese plan. Si no, usamos el del servicio (que podría ser undefined si no está activo)
    // Pero espera, si es una renovación, deberíamos usar el plan actual o permitir cambio?
    // Por simplicidad: si req.body.planType está presente, usamos ese precio.

    // NOTA: Para este fix, asumimos que si el usuario paga, elige plan o renueva.
    // Si envía planType='basic', cobramos basic. Si 'pro', cobramos pro.
    // Si no envía nada, usamos price_monthly (legacy/default pro).

    const targetPlan = req.body.planType || clientService.plan_type || 'pro';
    let priceToCharge = 0;

    if (targetPlan === 'basic') {
      priceToCharge = parseFloat(clientService.price_basic || 0);
    } else {
      priceToCharge = parseFloat(clientService.price_monthly || 0);
    }

    if (priceToCharge <= 0) {
      // Fallback si price_basic no está seteado en DB
      priceToCharge = parseFloat(clientService.price_monthly || 0);
    }

    // Crear orden de PayPal
    const order = await paypalService.createOrder({
      amount: priceToCharge,
      currency: 'USD',
      description: `Suscripción ${clientService.service_name} (${targetPlan.toUpperCase()})`,
      returnUrl: `${baseForPayPal}/client/payments?success=true`,
      cancelUrl: `${baseForPayPal}/client/payments?cancelled=true`,
      metadata: {
        clientId: req.user.id,
        serviceId: clientServiceId,
        planType: targetPlan
      }
    });

    // Guardar orden pendiente en la base de datos
    const reference = generatePaymentReference();
    await query(`
      INSERT INTO payments (client_id, client_service_id, amount, currency, method, reference, status, paypal_order_id)
      VALUES ($1, $2, $3, 'USD', 'paypal', $4, 'pending', $5)
    `, [req.user.id, clientServiceId, priceToCharge, reference, order.orderId]);

    res.json({
      success: true,
      data: {
        orderId: order.orderId,
        approvalUrl: order.approvalUrl
      }
    });

  } catch (error) {
    console.error('Error en createPayPalOrder:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al crear orden de pago'
    });
  }
};

const capturePayPalOrder = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'ID de orden requerido'
      });
    }

    // Capturar el pago
    const capture = await paypalService.captureOrder(orderId);

    if (!capture.success) {
      if (capture.alreadyCaptured) {
        return res.status(400).json({
          success: false,
          error: 'Este pago ya fue procesado'
        });
      }
      throw new Error(capture.error);
    }

    // Actualizar pago en la base de datos
    const paymentResult = await query(`
      UPDATE payments
      SET status = 'completed',
          paypal_capture_id = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE paypal_order_id = $2 AND status = 'pending'
      RETURNING *
    `, [capture.transactionId, orderId]);

    if (paymentResult.rows.length === 0) {
      // Intentar buscar por orderId en metadata
    }

    const payment = paymentResult.rows[0];

    if (payment) {
      // Activar/renovar servicio
      await query(`
        UPDATE client_services
        SET status = 'active',
            subscription_started_at = COALESCE(subscription_started_at, CURRENT_TIMESTAMP),
            subscription_ends_at = CURRENT_TIMESTAMP + INTERVAL '30 days',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [payment.client_service_id]);
    }

    res.json({
      success: true,
      message: 'Pago procesado exitosamente',
      data: {
        transactionId: capture.transactionId,
        amount: capture.amount,
        currency: capture.currency
      }
    });

  } catch (error) {
    console.error('Error en capturePayPalOrder:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al procesar el pago'
    });
  }
};

const submitTransferProof = async (req, res) => {
  try {
    const { client_service_id, reference, planType } = req.body;

    if (!client_service_id || !reference) {
      return res.status(400).json({
        success: false,
        error: 'ID de servicio y referencia son requeridos'
      });
    }

    // Verificar servicio
    const csResult = await query(`
      SELECT cs.*, s.price_monthly, s.price_basic, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.id = $1 AND cs.client_id = $2
    `, [client_service_id, req.user.id]);

    if (csResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Servicio no encontrado'
      });
    }

    const clientService = csResult.rows[0];

    // Verificar que el servicio realmente necesita pago
    if (clientService.status === 'active' && clientService.subscription_ends_at) {
      const daysRemaining = Math.ceil((new Date(clientService.subscription_ends_at) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining > 5) {
        return res.status(400).json({
          success: false,
          error: `Tu suscripción está activa hasta ${new Date(clientService.subscription_ends_at).toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' })}. Podrás renovar cuando falten 5 días o menos.`
        });
      }
    }

    // Procesar archivo subido si existe → subir a Cloudinary
    let receiptUrl = null;
    if (req.file) {
      try {
        const { uploadFromBuffer } = require('../services/cloudinaryService');
        const uploaded = await uploadFromBuffer(req.file.buffer, 'receipts');
        receiptUrl = uploaded.url;
      } catch (uploadErr) {
        console.error('Error subiendo comprobante a Cloudinary:', uploadErr.message);
      }
    }

    // Determine amount based on planType
    const targetPlan = planType || clientService.plan_type || 'pro';
    let amountToCharge = parseFloat(clientService.price_monthly || 0);

    if (targetPlan === 'basic') {
      amountToCharge = parseFloat(clientService.price_basic || clientService.price_monthly || 0);
    }

    // Crear pago pendiente de validación
    const paymentRef = generatePaymentReference();
    const notes = `Plan: ${targetPlan}. Ref: ${reference}`;

    await query(`
      INSERT INTO payments (client_id, client_service_id, amount, currency, method, reference, status, receipt_url, notes)
      VALUES ($1, $2, $3, 'USD', 'transfer', $4, 'pending', $5, $6)
    `, [req.user.id, client_service_id, amountToCharge, paymentRef, receiptUrl, notes]);

    res.json({
      success: true,
      message: 'Comprobante enviado. Será validado en 24-48 horas hábiles.',
      data: {
        reference: paymentRef
      }
    });

  } catch (error) {
    console.error('Error en submitTransferProof:', error);
    res.status(500).json({
      success: false,
      error: 'Error al enviar comprobante'
    });
  }
};

// ==================== DASHBOARD ====================

const getDashboard = async (req, res) => {
  try {
    const clientId = req.user.id;

    // Mensajes hoy (todas las plataformas)
    const messagesTodayResult = await query(`
      SELECT COUNT(*) as total FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN client_services cs ON c.client_service_id = cs.id
      WHERE cs.client_id = $1 AND m.created_at >= CURRENT_DATE
    `, [clientId]);

    // Conversaciones activas (últimas 24h)
    const activeConversationsResult = await query(`
      SELECT COUNT(*) as total FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      WHERE cs.client_id = $1
        AND c.last_message_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
    `, [clientId]);

    // Total conversaciones
    const totalConversationsResult = await query(`
      SELECT COUNT(*) as total FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      WHERE cs.client_id = $1
    `, [clientId]);

    // Mensajes no leídos
    const unreadResult = await query(`
      SELECT COALESCE(SUM(c.unread_count), 0) as total FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      WHERE cs.client_id = $1
    `, [clientId]);

    // Servicios activos
    const servicesResult = await query(`
      SELECT s.code, s.name, cs.status, cs.trial_ends_at
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND cs.status IN ('active', 'trial')
    `, [clientId]);

    // Mensajes por día (últimos 7 días)
    const messagesPerDayResult = await query(`
      SELECT DATE(m.created_at) as date,
             COUNT(*) FILTER (WHERE m.sender_type = 'contact') as incoming,
             COUNT(*) FILTER (WHERE m.sender_type = 'bot') as bot_replies,
             COUNT(*) FILTER (WHERE m.sender_type = 'human') as human_replies
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN client_services cs ON c.client_service_id = cs.id
      WHERE cs.client_id = $1
        AND m.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
      GROUP BY DATE(m.created_at)
      ORDER BY date ASC
    `, [clientId]);

    // Conversaciones recientes
    const recentConversationsResult = await query(`
      SELECT c.id, c.contact_name, c.contact_id, c.unread_count,
             c.last_message_at, s.code as platform,
             (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM conversations c
      JOIN client_services cs ON c.client_service_id = cs.id
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT 5
    `, [clientId]);

    // Trial info
    const trialResult = await query(`
      SELECT cs.trial_ends_at, cs.status, s.name as service_name
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1 AND cs.status = 'trial'
      ORDER BY cs.trial_ends_at ASC
      LIMIT 1
    `, [clientId]);

    const trialInfo = trialResult.rows.length > 0 ? {
      service: trialResult.rows[0].service_name,
      endsAt: trialResult.rows[0].trial_ends_at,
      daysRemaining: Math.max(0, Math.ceil(
        (new Date(trialResult.rows[0].trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24)
      ))
    } : null;

    res.json({
      success: true,
      data: {
        stats: {
          messagesToday: parseInt(messagesTodayResult.rows[0].total),
          activeConversations: parseInt(activeConversationsResult.rows[0].total),
          totalConversations: parseInt(totalConversationsResult.rows[0].total),
          unreadMessages: parseInt(unreadResult.rows[0].total)
        },
        activeServices: servicesResult.rows,
        messagesPerDay: messagesPerDayResult.rows,
        recentConversations: recentConversationsResult.rows,
        trial: trialInfo
      }
    });

  } catch (error) {
    console.error('Error en getDashboard:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ==================== KNOWLEDGE FILES (GLOBAL POR CLIENTE) ====================

const getKnowledgeFiles = async (req, res) => {
  try {
    const filesResult = await query(`
      SELECT id, filename, file_type, file_size, text_length, created_at
      FROM client_knowledge_files
      WHERE client_id = $1
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      data: { files: filesResult.rows }
    });

  } catch (error) {
    console.error('Error en getKnowledgeFiles:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const uploadKnowledgeFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No se recibió ningún archivo' });
    }

    // Check file limit (max 5 files)
    const countResult = await query(
      'SELECT COUNT(*) as total FROM client_knowledge_files WHERE client_id = $1',
      [req.user.id]
    );

    if (parseInt(countResult.rows[0].total) >= 5) {
      return res.status(400).json({ success: false, error: 'Límite máximo de 5 archivos alcanzado' });
    }

    // Extract text based on file type
    let extractedText = '';
    const fileType = req.file.mimetype;
    const fileName = req.file.originalname;

    const ext = path.extname(fileName).toLowerCase();

    if (fileType === 'application/pdf') {
      try {
        const pdfData = await pdfParse(req.file.buffer);
        extractedText = pdfData.text;
      } catch (pdfError) {
        console.error('Error parsing PDF:', pdfError);
        return res.status(400).json({ success: false, error: 'Error al procesar el archivo PDF' });
      }
    } else if (fileType === 'text/plain' || ext === '.txt') {
      extractedText = req.file.buffer.toString('utf-8');
    } else if (ext === '.csv' || fileType === 'text/csv') {
      // CSV: leer como texto y convertir a formato legible
      try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        // Convertir a texto: encabezados como contexto + cada fila
        extractedText = rows.map(row => row.join(' | ')).join('\n');
      } catch (csvError) {
        console.error('Error parsing CSV:', csvError);
        return res.status(400).json({ success: false, error: 'Error al procesar el archivo CSV' });
      }
    } else if (ext === '.xlsx' || ext === '.xls' ||
               fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
               fileType === 'application/vnd.ms-excel') {
      // Excel: extraer todas las hojas como texto
      try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const textParts = [];
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          if (rows.length > 0) {
            textParts.push(`=== Hoja: ${sheetName} ===`);
            textParts.push(rows.map(row => row.join(' | ')).join('\n'));
          }
        });
        extractedText = textParts.join('\n\n');
      } catch (xlsxError) {
        console.error('Error parsing Excel:', xlsxError);
        return res.status(400).json({ success: false, error: 'Error al procesar el archivo Excel' });
      }
    } else {
      return res.status(400).json({ success: false, error: 'Formato no soportado. Usa PDF, TXT, CSV o Excel.' });
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'No se pudo extraer texto del archivo' });
    }

    // Save to database
    const insertResult = await query(`
      INSERT INTO client_knowledge_files (client_id, filename, file_type, extracted_text, file_size, text_length)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, filename, file_type, file_size, text_length, created_at
    `, [req.user.id, fileName, fileType, extractedText, req.file.size, extractedText.length]);

    // Respond immediately — indexing happens in the background
    res.status(201).json({
      success: true,
      message: 'Archivo subido y texto extraído correctamente',
      data: { file: insertResult.rows[0] }
    });

    // Async RAG indexing (non-blocking — failure does NOT affect the response)
    const { id: fileId } = insertResult.rows[0];
    setImmediate(() => {
      indexKnowledgeFile(fileId, req.user.id, extractedText, fileName)
        .catch(err => console.error('[RAG] Background indexing failed:', err.message));
    });

  } catch (error) {
    console.error('Error en uploadKnowledgeFile:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

const deleteKnowledgeFile = async (req, res) => {
  try {
    const { fileId } = req.params;

    const deleteResult = await query(
      'DELETE FROM client_knowledge_files WHERE id = $1 AND client_id = $2 RETURNING id',
      [fileId, req.user.id]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado' });
    }

    res.json({ success: true, message: 'Archivo eliminado correctamente' });

  } catch (error) {
    console.error('Error en deleteKnowledgeFile:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// Obtener pedidos del cliente
// =====================================================
const getMyOrders = async (req, res) => {
  try {
    const result = await query(`
      SELECT
        o.id,
        o.conversation_id,
        o.total_amount,
        o.status,
        o.voucher_url,
        o.items,
        o.shipping_info,
        o.created_at,
        o.updated_at
      FROM orders o
      WHERE o.client_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);

    res.json({
      success: true,
      data: { orders: result.rows }
    });

  } catch (error) {
    console.error('Error en getMyOrders:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// Actualizar estado de un pedido (cliente aprueba/rechaza)
// =====================================================
const updateOrderStatus = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['approved', 'rejected', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Estado no válido. Usa: approved, rejected, completed' });
    }

    const result = await query(`
      UPDATE orders
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND client_id = $3
      RETURNING *
    `, [status, orderId, clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error en updateOrderStatus:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// =====================================================
// Obtener estadísticas de pedidos
// =====================================================
const getOrderStats = async (req, res) => {
  try {
    const clientId = req.user.id;

    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'paid_voucher') as paid_voucher,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
        COUNT(*) as total,
        COALESCE(SUM(total_amount) FILTER (WHERE status IN ('approved', 'completed')), 0) as total_revenue
      FROM orders
      WHERE client_id = $1
    `, [clientId]);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error en getOrderStats:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

// ==================== BILLING / PAYG ====================

const getBillingDashboard = async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);

    // Monthly token usage
    const usage = await getMonthlyUsage(req.user.id, year, month);

    // Get all services with their credit_balance and plan_type
    const servicesResult = await query(
      `SELECT cs.id, cs.plan_type, cs.credit_balance, s.name AS service_name, s.code AS service_code
       FROM client_services cs
       JOIN services s ON cs.service_id = s.id
       WHERE cs.client_id = $1 AND cs.status NOT IN ('cancelled')
       ORDER BY s.name`,
      [req.user.id]
    );

    const services = servicesResult.rows.map(svc => ({
      ...svc,
      credit_balance: parseFloat(svc.credit_balance) || 0,
      is_payg: svc.plan_type === PAYG.PLAN_TYPE,
      is_low_balance: svc.plan_type === PAYG.PLAN_TYPE && parseFloat(svc.credit_balance) <= PAYG.LOW_BALANCE_ALERT_USD,
    }));

    // Daily usage (last 30 days) for each PAYG service
    const paygServices = services.filter(s => s.is_payg);
    const dailyUsageMap = {};
    for (const svc of paygServices) {
      dailyUsageMap[svc.id] = await getDailyUsage(svc.id, 30);
    }

    res.json({
      success: true,
      data: {
        year,
        month,
        usage,
        services,
        dailyUsage: dailyUsageMap,
        pricing: {
          inputPricePer1K:  PAYG.INPUT_PRICE_PER_1K,
          outputPricePer1K: PAYG.OUTPUT_PRICE_PER_1K,
          margin: '80%',
        },
      }
    });
  } catch (error) {
    console.error('Error en getBillingDashboard:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
  getBusiness,
  updateBusiness,
  getMyServices,
  getServiceDetail,
  activateTrial,
  getMyPayments,
  createPayment,
  uploadReceipt,
  getSubscriptionStatus,
  getDashboard,
  // Nuevas funciones de pago
  getServicesToPay,
  getPaymentHistory,
  getBankDetails,
  createPayPalOrder,
  capturePayPalOrder,
  submitTransferProof,
  // Suscripción sin trial
  createPendingSubscription,
  // Pedidos
  getMyOrders,
  updateOrderStatus,
  getOrderStats,
  // Knowledge files globales
  getKnowledgeFiles,
  uploadKnowledgeFile,
  deleteKnowledgeFile,
  cancelService,
  // Billing / PAYG
  getBillingDashboard,
  uploadBusinessLogo,
  uploadBusinessBanner,
};
