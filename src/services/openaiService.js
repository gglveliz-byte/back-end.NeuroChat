const OpenAI = require('openai');
const { query } = require('../config/database');
const { uploadFromBase64 } = require('./cloudinaryService');
const { getProvider, createChatCompletion, createToolResultCompletion } = require('./aiProviderService');
const { searchRelevantChunks } = require('./embeddingService');
const { emitOrderVoucherReceived } = require('../websocket/socketManager');

// Inicializar cliente de OpenAI (still needed for sentiment/intent/quickReplies)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =====================================================
// DEFINICIÓN DE HERRAMIENTAS (TOOLS)
// =====================================================
const availableTools = [
  {
    type: 'function',
    function: {
      name: 'get_products',
      description: 'Obtener lista de productos del catálogo del negocio. Útil cuando el usuario pregunta por productos, precios o disponibilidad.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Término de búsqueda (nombre del producto o palabra clave). Dejar vacío para ver todos.',
          },
          category: {
            type: 'string',
            description: 'Filtrar por categoría si el usuario la especifica.',
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Crear una orden de compra pendiente. ANTES de llamar esta herramienta, DEBES haber recopilado: nombre completo, teléfono/WhatsApp y dirección de envío del cliente.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Lista de ítems a comprar',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string', description: 'ID del producto (opcional si se da nombre)' },
                product_name: { type: 'string', description: 'Nombre exacto del producto (usar si no tienes el ID)' },
                quantity: { type: 'integer', description: 'Cantidad' }
              },
              required: ['quantity']
            }
          },
          customer_name: { type: 'string', description: 'Nombre completo del cliente' },
          customer_phone: { type: 'string', description: 'Teléfono o WhatsApp del cliente' },
          customer_email: { type: 'string', description: 'Email del cliente (opcional)' },
          shipping_address: { type: 'string', description: 'Dirección completa de envío' }
        },
        required: ['items', 'customer_name', 'customer_phone', 'shipping_address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_voucher',
      description: 'Guardar comprobante de pago para una orden existente. Usar cuando el cliente dice que ya pagó y/o envía una imagen como comprobante. IMPORTANTE: order_id DEBE ser el UUID real devuelto por create_order o get_pending_orders. NUNCA inventes el order_id. Si no tienes el UUID exacto, llama primero a get_pending_orders para obtenerlo.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'UUID real de la orden (formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Obtenido de la respuesta de create_order o de get_pending_orders.' },
        },
        required: ['order_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_orders',
      description: 'Obtener órdenes pendientes de pago de la conversación actual. Usar cuando el cliente pregunta por sus pedidos o quiere pagar una orden.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_webchat_lead',
      description: 'Guardar datos de contacto de un visitante web que quiere ser contactado por un asesor humano. USAR SOLO en canal webchat cuando el visitante ya dio su nombre y datos de contacto y quiere hablar con un humano.',
      parameters: {
        type: 'object',
        properties: {
          visitor_name: { type: 'string', description: 'Nombre del visitante' },
          visitor_phone: { type: 'string', description: 'Teléfono o WhatsApp del visitante' },
          visitor_email: { type: 'string', description: 'Email del visitante (si lo dio)' },
          interest: { type: 'string', description: 'Breve resumen de qué necesita o en qué está interesado el visitante' }
        },
        required: ['visitor_name', 'interest']
      }
    }
  }
];

/**
 * Ejecuta la lógica de las herramientas solicitadas por la IA
 */
const executeTool = async (toolName, args, clientId, conversationId, imageUrl = null) => {
  console.log(`🛠️ Ejecutando herramienta: ${toolName}`, args);

  if (toolName === 'get_products') {
    try {
      let sql = 'SELECT id, name, description, price, currency, stock, media_urls FROM products WHERE client_id = $1 AND is_active = true';
      const params = [clientId];
      let paramCount = 1;

      if (args.search) {
        paramCount++;
        sql += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
        params.push(`%${args.search}%`);
      }

      if (args.category) {
        paramCount++;
        sql += ` AND category ILIKE $${paramCount}`;
        params.push(`%${args.category}%`);
      }

      sql += ' LIMIT 5'; // Limitar resultados para no saturar el prompt

      const result = await query(sql, params);

      if (result.rows.length === 0) {
        return JSON.stringify({ message: "No se encontraron productos con esos criterios." });
      }

      // Strip media_urls — las imágenes las envía el backend por separado. La IA NO debe verlas ni incluirlas en texto.
      return JSON.stringify(result.rows.map(({ media_urls, ...p }) => p));

    } catch (error) {
      console.error('Error en get_products:', error);
      return JSON.stringify({ error: "Error al consultar el catálogo." });
    }
  }

  if (toolName === 'create_order') {
    try {
      console.log('🛒 Tool create_order called with:', JSON.stringify(args));
      const { items, shipping_address, customer_name, customer_phone, customer_email } = args;
      // Validar y calcular total
      let totalAmount = 0;
      const processedItems = [];

      const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

      for (const item of items) {
        let prodRes;

        // Buscar por ID solo si es UUID válido
        if (item.product_id && isValidUUID(item.product_id)) {
          prodRes = await query('SELECT id, price, name FROM products WHERE id = $1 AND client_id = $2', [item.product_id, clientId]);
        }
        // Si product_id no es UUID o no existe, buscar por nombre (usando product_id o product_name como texto)
        const searchName = item.product_name || item.product_id;
        if ((!prodRes || prodRes.rows.length === 0) && searchName) {
          prodRes = await query('SELECT id, price, name FROM products WHERE name ILIKE $1 AND client_id = $2', [`%${searchName}%`, clientId]);
        }

        if (!prodRes || prodRes.rows.length === 0) {
          return JSON.stringify({ error: `Producto no encontrado: ${item.product_id || item.product_name}` });
        }

        const prod = prodRes.rows[0];
        const subtotal = Number(prod.price) * item.quantity;
        totalAmount += subtotal;
        processedItems.push({
          product_id: prod.id,
          name: prod.name,
          price: Number(prod.price),
          quantity: item.quantity,
          subtotal: subtotal
        });
      }

      // Insertar orden
      // Necesitamos conversation_id y contact_id?
      // El tool execute no recibe conversation_id directamente, pero podemos pasarlo en context si es necesario.
      // Por ahora, asumimos que el bot maneja la respuesta.
      // Pero para guardar en DB necesitamos asociarlo.
      // LIMITACIÓN: executeTool no tiene acceso a conversation_id explícito aquí a menos que cambiemos la firma.
      // POR AHORA: Retornar los detalles de la orden generada (pre-orden) y pedir confirmación al usuario.
      // O: Si queremos guardar, necesitamos conversation_id.

      // Vamos a guardar una orden "draft" o simplemente retornar la info para que el bot confirme.
      // Al crear una orden ('create_order'), SIEMPRE usa el 'id' exacto (UUID) del producto que obtuviste con 'get_products'. NUNCA inventes o adivines el ID.
      // Si el usuario quiere comprar, primero busca el producto para obtener su ID y precio.
      // Antes de llamar a 'create_order', confirma con el usuario los detalles (producto, cantidad, precio total).
      // Asumiremos que creamos orden en estado "pending".

      // Insertar orden real en estado 'pending'
      let orderId = null;
      if (conversationId) {
        // Necesitamos contact_id? Podemos obtenerlo de la conversación o no guardarlo en orders si no es necesario (pero orders tiene client_id y conversation_id)
        // La tabla orders tiene: id, conversation_id, client_id, contact_id, total_amount, status, voucher_url, items, shipping_info

        // Obtener conversation para sacar contact_id? O simplemente guardar.
        // Asumimos contact_id null o buscamos.
        // Mejor: guardar conversation_id y items.

        try {
          const shippingInfo = {
            customer_name: customer_name || null,
            customer_phone: customer_phone || null,
            customer_email: customer_email || null,
            address: shipping_address || null
          };
          const orderRes = await query(`
                INSERT INTO orders (conversation_id, client_id, items, total_amount, status, shipping_info)
                VALUES ($1, $2, $3, $4, 'pending', $5)
                RETURNING id
            `, [conversationId, clientId, JSON.stringify(processedItems), totalAmount, JSON.stringify(shippingInfo)]);
          orderId = orderRes.rows[0].id;
        } catch (dbErr) {
          console.error('Error insertando orden:', dbErr);
          // Fallback a solo resumen si falla DB
        }
      }

      const orderSummary = {
        order_id: orderId || 'draft',
        status: 'pending',
        total: totalAmount,
        currency: 'USD',
        items: processedItems,
        shipping_address: shipping_address || 'No especificada',
        message: orderId
          ? `Orden #${orderId} creada exitosamente. Por favor procede al pago.`
          : 'Orden creada preliminarmente. Por favor confirma para proceder al pago.'
      };

      return JSON.stringify(orderSummary);

    } catch (error) {
      console.error('Error en create_order:', error);
      return JSON.stringify({ error: 'Error creando la orden' });
    }
  }

  if (toolName === 'get_pending_orders') {
    try {
      const result = await query(`
        SELECT id, total_amount, status, items, created_at
        FROM orders
        WHERE conversation_id = $1 AND status IN ('pending', 'paid_voucher')
        ORDER BY created_at DESC LIMIT 5
      `, [conversationId]);

      if (result.rows.length === 0) {
        return JSON.stringify({ message: 'No hay órdenes pendientes en esta conversación.' });
      }
      return JSON.stringify(result.rows);
    } catch (error) {
      console.error('Error en get_pending_orders:', error);
      return JSON.stringify({ error: 'Error al consultar órdenes.' });
    }
  }

  if (toolName === 'save_webchat_lead') {
    try {
      console.log('📋 Tool save_webchat_lead called with:', JSON.stringify(args));
      const { visitor_name, visitor_phone, visitor_email, interest } = args;

      // 1. Actualizar conversación con datos del visitante
      if (conversationId) {
        await query(`
          UPDATE conversations
          SET contact_name = COALESCE($1, contact_name),
              contact_phone = COALESCE($2, contact_phone),
              contact_email = COALESCE($3, contact_email),
              needs_human_attention = true,
              is_bot_active = false
          WHERE id = $4
        `, [visitor_name || null, visitor_phone || null, visitor_email || null, conversationId]);
      }

      // 2. Crear order tipo "lead" para que aparezca en el panel de pedidos del cliente
      const leadItems = [{
        name: 'Solicitud de asesor',
        description: interest || 'Visitante web solicita contacto con asesor humano',
        quantity: 1,
        price: 0
      }];
      const shippingInfo = {
        customer_name: visitor_name || 'Visitante Web',
        customer_phone: visitor_phone || null,
        customer_email: visitor_email || null,
        source: 'webchat_lead',
        interest: interest || ''
      };

      let leadId = null;
      if (conversationId && clientId) {
        const leadRes = await query(`
          INSERT INTO orders (conversation_id, client_id, items, total_amount, status, shipping_info, notes)
          VALUES ($1, $2, $3, 0, 'lead', $4, $5)
          RETURNING id
        `, [
          conversationId,
          clientId,
          JSON.stringify(leadItems),
          JSON.stringify(shippingInfo),
          `Lead webchat: ${visitor_name || 'Anónimo'} — ${interest || 'Sin detalle'}`
        ]);
        leadId = leadRes.rows[0].id;
      }

      return JSON.stringify({
        success: true,
        lead_id: leadId,
        message: `Datos guardados. El equipo contactará a ${visitor_name} pronto.`
      });
    } catch (error) {
      console.error('Error en save_webchat_lead:', error);
      return JSON.stringify({ success: true, message: 'Datos registrados. Un asesor te contactará pronto.' });
    }
  }

  if (toolName === 'save_voucher') {
    try {
      let { order_id } = args;

      const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

      // Si el order_id no es un UUID válido, buscar la última orden pendiente de la conversación
      if (!order_id || !isValidUUID(order_id)) {
        const fallbackOrder = await query(`
          SELECT id, status, total_amount FROM orders
          WHERE conversation_id = $1 AND status IN ('pending', 'paid_voucher')
          ORDER BY created_at DESC LIMIT 1
        `, [conversationId]);

        if (fallbackOrder.rows.length === 0) {
          return JSON.stringify({ error: 'No se encontró una orden pendiente para registrar el comprobante. Primero crea una orden.' });
        }
        order_id = fallbackOrder.rows[0].id;
      }

      // Verify order exists and belongs to this conversation
      const orderRes = await query(`
        SELECT id, status, total_amount FROM orders
        WHERE id = $1 AND conversation_id = $2
      `, [order_id, conversationId]);

      if (orderRes.rows.length === 0) {
        // Último intento: buscar por conversación sin verificar el ID exacto
        const fallbackOrder = await query(`
          SELECT id, status, total_amount FROM orders
          WHERE conversation_id = $1 AND status IN ('pending', 'paid_voucher')
          ORDER BY created_at DESC LIMIT 1
        `, [conversationId]);

        if (fallbackOrder.rows.length === 0) {
          return JSON.stringify({ error: 'Orden no encontrada. Primero crea una orden con create_order.' });
        }
        order_id = fallbackOrder.rows[0].id;
      }

      if (orderRes.rows[0].status === 'approved' || orderRes.rows[0].status === 'completed') {
        return JSON.stringify({ message: 'Esta orden ya fue aprobada/completada.' });
      }

      // ── Vision validation: verificar que la imagen luce como un comprobante real ──
      if (imageUrl) {
        try {
          const visionCheck = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 10,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Does this image look like a real payment receipt, bank transfer screenshot, or transaction confirmation? Answer only: YES or NO.'
                },
                { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }
              ]
            }]
          });
          const verdict = (visionCheck.choices[0]?.message?.content || '').trim().toUpperCase();
          if (!verdict.startsWith('YES')) {
            return JSON.stringify({
              success: false,
              action: 'voucher_rejected',
              message: 'La imagen no parece un comprobante de pago válido. Por favor envía una captura de la transferencia bancaria o recibo de pago.'
            });
          }
        } catch (visionErr) {
          // Si falla la validación Vision, continuamos (no bloquear al usuario)
          console.warn('Vision validation failed, continuing:', visionErr.message);
        }
      }

      // Subir imagen del comprobante a Cloudinary si está disponible
      let voucherUrl = null;
      if (imageUrl) {
        try {
          const uploaded = await uploadFromBase64(imageUrl, 'vouchers');
          voucherUrl = uploaded.url;
        } catch (cloudErr) {
          console.error('Error subiendo comprobante a Cloudinary:', cloudErr.message);
        }
      }

      // Actualizar orden con estado + URL del comprobante
      await query(`
        UPDATE orders
        SET status = 'paid_voucher',
            voucher_url = COALESCE($2, voucher_url),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [order_id, voucherUrl]);

      // ── WebSocket: notificar al panel del cliente en tiempo real ──
      try {
        const svcRes = await query(`
          SELECT cs.client_id, s.code as service_code
          FROM conversations c
          JOIN client_services cs ON c.client_service_id = cs.id
          JOIN services s ON cs.service_id = s.id
          WHERE c.id = $1
        `, [conversationId]);
        if (svcRes.rows.length > 0) {
          const { client_id, service_code } = svcRes.rows[0];
          emitOrderVoucherReceived(client_id, service_code, {
            orderId: order_id,
            conversationId,
            voucherUrl,
            timestamp: new Date().toISOString()
          });
        }
      } catch (wsErr) {
        console.error('Error emitiendo voucher WS:', wsErr.message);
      }

      return JSON.stringify({
        success: true,
        order_id: order_id,
        action: 'voucher_pending_validation',
        message: `Comprobante recibido para la orden #${order_id.slice(0, 8)}. El equipo revisará tu pago y confirmarán pronto.`
      });

    } catch (error) {
      console.error('Error en save_voucher:', error);
      return JSON.stringify({ error: 'Error al procesar el comprobante.' });
    }
  }

  return JSON.stringify({ error: "Herramienta no encontrada" });
};

/**
 * Genera una respuesta usando OpenAI basada en el contexto del bot y el historial de mensajes
 * Soporta Function Calling (Tools)
 */
const generateResponse = async ({
  userMessage,
  messageHistory = [],
  botConfig = {},
  businessInfo = {},
  clientId,
  conversationId,
  planType = 'pro',
  imageUrl = null, // Base64 data URL for image messages (voucher validation)
  isNewConversation = false,
  platform = null, // 'webchat', 'whatsapp', 'messenger', etc.
}) => {
  try {
    // --- 0. Select AI provider (Groq for trial = free, OpenAI for paid = function calling) ---
    const provider = getProvider(planType);
    const useTools = provider === 'openai' && planType !== 'basic';

    // --- 1. RAG: search relevant knowledge chunks for this user message ---
    let ragContext = [];
    if (clientId && userMessage) {
      try {
        ragContext = await searchRelevantChunks(userMessage, clientId, 5);
      } catch (ragErr) {
        console.warn('[RAG] Search failed, continuing without context:', ragErr.message);
      }
    }

    // --- 2. Build system prompt (includes RAG chunks if found) ---
    const systemPrompt = buildSystemPrompt(botConfig, businessInfo, planType, isNewConversation, ragContext, platform);

    // --- 3. Build messages array (last 15 messages for context window efficiency) ---
    const messages = [
      { role: 'system', content: systemPrompt },
      ...formatMessageHistory(messageHistory),
    ];

    // If there's an image (e.g., voucher), use multimodal message (OpenAI only)
    if (imageUrl && provider === 'openai' && planType !== 'basic') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userMessage || 'El cliente envió esta imagen como comprobante de pago. Analiza si parece un comprobante válido (captura de transferencia, recibo bancario, etc). Si hay una orden pendiente, usa save_voucher.' },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }
        ]
      });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const completionOptions = {
      maxTokens: botConfig.maxTokens || 300,
      temperature: botConfig.temperature || 0.7,
      tools: useTools ? availableTools : undefined,
      toolChoice: useTools ? 'auto' : undefined,
    };

    // --- 4. First AI call ---
    let completion = await createChatCompletion(provider, messages, completionOptions);
    let responseMessage = completion.choices[0].message;

    // --- 5. Handle function calling (OpenAI only) ---
    const productImages = []; // { url, caption } para enviar después del texto

    if (responseMessage.tool_calls && useTools) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseErr) {
          console.error('Error parseando argumentos de tool:', parseErr.message);
          functionArgs = {};
        }

        let functionResponse;
        try {
          functionResponse = await executeTool(functionName, functionArgs, clientId, conversationId, imageUrl);
        } catch (toolErr) {
          console.error(`Error ejecutando herramienta ${functionName}:`, toolErr.message);
          functionResponse = JSON.stringify({ error: 'Error ejecutando herramienta' });
        }

        // Extraer imágenes de productos (máx 3) para enviarlas como media después del texto
        if (functionName === 'get_products') {
          try {
            const products = JSON.parse(functionResponse);
            console.log(`[get_products] Resultado: ${Array.isArray(products) ? products.length + ' productos' : JSON.stringify(products)}`);
            if (Array.isArray(products)) {
              for (const product of products) {
                if (productImages.length >= 3) break; // máx 3 imágenes para no saturar
                let urls = product.media_urls;
                if (typeof urls === 'string') {
                  try { urls = JSON.parse(urls); } catch { urls = []; }
                }
                console.log(`[get_products] "${product.name}" → media_urls:`, urls);
                if (Array.isArray(urls) && urls.length > 0 && urls[0]) {
                  productImages.push({
                    url: urls[0],
                    caption: `${product.name}${product.price ? ` — $${product.price}` : ''}`
                  });
                }
              }
              console.log(`[get_products] ${productImages.length} imágenes a enviar`);
            }
          } catch { /* ignorar si no parsea */ }
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: functionName,
          content: functionResponse,
        });
      }

      // Second call with tool results (always OpenAI)
      completion = await createToolResultCompletion(messages, {
        maxTokens: completionOptions.maxTokens,
        temperature: completionOptions.temperature,
      });

      responseMessage = completion.choices[0].message;
    }

    const finalResponse = responseMessage.content;

    if (!finalResponse) {
      throw new Error('No se recibió respuesta de OpenAI');
    }

    // Aggregate token usage across all completion calls
    // (first call + optional second call after tool execution)
    const usage = {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      totalTokens: completion.usage?.total_tokens || 0,
      provider,
      model: provider === 'groq'
        ? require('./aiProviderService').GROQ_MODEL
        : require('./aiProviderService').OPENAI_MODEL,
    };

    return {
      content: finalResponse.trim(),
      usage,
      productImages, // Array de { url, caption } — vacío si no se consultó el catálogo
    };

  } catch (error) {
    console.error('Error en OpenAI:', error.message);
    const fallback = botConfig.fallbackMessage ||
      'Lo siento, no puedo responder en este momento. Por favor, intenta de nuevo más tarde o contacta a un agente.';
    return {
      content: fallback,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'openai', model: 'gpt-4o-mini' },
      productImages: [],
    };
  }
};

/**
 * Construye el prompt del sistema basado en la configuración del bot
 */
/**
 * Genera el bloque de texto de métodos de pago para el system prompt.
 * Soporta formato nuevo { methods: [...] } y formato legacy { enabled, bank_name, ... }
 */
function buildPaymentBlock(paymentConfig, planType) {
  if (!planType || planType === 'trial') return '';

  const LABELS = {
    transfer: '🏦 Transferencia Bancaria', nequi: '💜 Nequi', daviplata: '🔴 Daviplata',
    yape: '🟣 Yape', paypal: '🔵 PayPal', cash: '💵 Efectivo / Contraentrega', other: '💳'
  };

  // Normalizar a array de métodos activos
  let methods = [];
  if (paymentConfig && Array.isArray(paymentConfig.methods)) {
    methods = paymentConfig.methods.filter(m => m.enabled);
  } else if (paymentConfig && paymentConfig.enabled && paymentConfig.bank_name) {
    // Formato legacy
    methods = [{ type: 'transfer', bank_name: paymentConfig.bank_name, account_holder: paymentConfig.account_holder, account_number: paymentConfig.account_number, account_type: paymentConfig.account_type, id_number: paymentConfig.id_number, instructions: paymentConfig.instructions }];
  }

  if (methods.length === 0) {
    return '\n━━━ INSTRUCCIONES DE PAGO ━━━\nEl negocio aún no ha configurado métodos de pago. Cuando el cliente quiera pagar, dile: "Para coordinar el pago, contáctanos directamente."';
  }

  const formatted = methods.map(m => {
    const label = m.type === 'other' ? ('💳 ' + (m.custom_label || 'Otro método')) : (LABELS[m.type] || m.type);
    const lines = ['• ' + label + ':'];
    if (m.type === 'transfer') {
      if (m.bank_name) lines.push('  Banco: ' + m.bank_name);
      if (m.account_type) lines.push('  Tipo: ' + m.account_type);
      if (m.account_holder) lines.push('  Titular: ' + m.account_holder);
      if (m.account_number) lines.push('  N° cuenta: ' + m.account_number);
      if (m.id_number) lines.push('  Cédula/RUC: ' + m.id_number);
    } else if (['nequi', 'daviplata', 'yape'].includes(m.type)) {
      if (m.phone) lines.push('  Número: ' + m.phone);
    } else if (m.type === 'paypal') {
      if (m.link) lines.push('  Link: ' + m.link);
    }
    if (m.instructions) lines.push('  ' + m.instructions);
    return lines.join('\n');
  }).join('\n\n');

  return '\n━━━ MÉTODOS DE PAGO ━━━\nAl confirmar la orden, presenta TODOS estos métodos y pregunta al cliente cuál prefiere:\n' + formatted + '\nLuego pídele que envíe el comprobante de pago a este chat.';
}

const buildSystemPrompt = (botConfig, businessInfo, planType = 'pro', isNewConversation = false, ragContext = [], platform = null) => {
  const {
    personality = 'amable y profesional',
    language = 'español',
    tone = 'conversacional',
    instructions = '',
    welcomeMessage = '',
    faq = [],
    knowledgeBase = '',
    knowledgeFiles = [],
    paymentConfig = {}
  } = botConfig;

  const paymentBlock = buildPaymentBlock(paymentConfig, planType);

  const {
    name: businessName = 'el negocio',
    industry = '',
    description = '',
    website = '',
    address = '',
    phone = '',
    schedule = ''
  } = businessInfo;



  const catalogUrl = website || (businessInfo.slug ? `${process.env.FRONTEND_URL || 'http://localhost:3000'}/store/${businessInfo.slug}` : '');

  let roleDefinition = '';
  let capabilities = '';

  if (planType === 'basic') {
    roleDefinition = `Sos la primera línea de atención de ${businessName}.
Tu único trabajo es informar, resolver dudas rápidas, dar precios si te los pasan, y derivar a un vendedor humano.
Hablás como una verdadera persona en WhatsApp, NO como ChatGPT. 
SOS DIRECTO. Cortás el rollo. Cero "Claro que sí" o "Con gusto te ayudo". Hablás en ${language}.`;

    capabilities = `REGLA DE VENTA:
- Si el usuario muestra cualquier intención de comprar, pedir algo o ver catálogo, decí algo como: "Ese tema te lo ve directo mi compañero de ventas. Te paso con un humano para cerrar eso rápido. 🤝"
- No intentes ser un vendedor porque no tenés acceso al catálogo ni podés armar órdenes.`;
  } else if (platform === 'webchat') {
    roleDefinition = `Sos el asesor virtual de ${businessName} en la página web. Carismático, cercano y profesional.
No sos un "chatbot genérico". Sos un asesor que genuinamente quiere ayudar al visitante y llevarlo a una conversión.
Tu objetivo: ENGANCHAR al visitante, resolver sus dudas, generar interés y conseguir sus datos de contacto para que un asesor humano lo cierre.
Hablás natural, cálido, con la ${personality} que se te indicó. Usás emojis con moderación.
Hablás en ${language}. Cero formalismos de IA.`;

    capabilities = `TUS HERRAMIENTAS:
- 'get_products': Para mostrar productos/servicios cuando pregunten. NUNCA inventes catálogo.
- 'save_webchat_lead': Para guardar datos del visitante (nombre, teléfono/email, interés). USALA cuando tengas los datos.
- 'create_order': Para crear pedidos si el visitante ya dio sus datos y quiere comprar algo concreto.

REGLAS DE ASESOR WEB:
- Tu meta es ENGANCHAR, INFORMAR y CONVERTIR (conseguir datos para que un humano cierre la venta)
- Si te preguntan qué tenés, usá 'get_products' y mencioná 2-3 opciones de forma conversacional
- SIEMPRE hacé contra-preguntas para mantener al visitante enganchado
- Cuando notes interés real, llevá la conversación hacia recolectar datos de contacto
- NUNCA dejes la conversación sin hacer al menos un intento de obtener datos`;
  } else {
    roleDefinition = `Sos EL ASESOR ESTRELLA de ventas de ${businessName}. Llevás años vendiendo por WhatsApp.
No sos un "asistente virtual", ni seguís un guión robótico. Sos directo, brillante y un cerrador nato.
Tu meta absoluta es VENDER. Hablás natural, rápido, con la ${personality} que se te indicó, pero siempre con el ADN de un cerrador empedernido.
Hablás en ${language}. Cero modismos raros o formales de IA.`;

    capabilities = `TUS PUNTAS DE LANZA (HERRAMIENTAS):
- 'get_products': BUSCÁ ACÁ cada vez que pregunten "qué tienen", "qué marcas manejas", o pidan un producto puntual. NUNCA INVENTES CATALOGO.
- 'create_order': CREÁ LA ORDEN ni bien el cliente diga "lo llevo", "dame ese", "quiero comprar". Cortito y al pie. Pedile nombre y dirección de una.
- 'save_voucher': VALIDÁ EL PAGO cuando te envíen la foto.

REGLAS DE VENDEDOR PRO:
- Si te preguntan qué tenés de forma genérica, tirás el 'get_products' vacío. Y en tu mensaje MENCIONAS 2 o 3 opciones en texto plano, conversacional. Ej: "Mirá, de eso tengo los X a $40 o los Y a $50. Cuál te suena mejor?"
- SIEMPRE que respondas precio, meté una CONTRA-PREGUNTA de cierre: "¿Te lo mando hoy mismo?", "¿Para qué ciudad sería?". NUNCA dejes la conversación flotando con un "Estoy aquí si tienes más preguntas".
- Cuando el cliente te da un dato para el pedido (ej: su nombre), NUNCA digas "perfecto, anotado, ahora pasame la dirección". DECÍ: "Genial. A qué dirección mandamos el paquete?". (Corto. Humano).`;
  }

  let prompt = `${roleDefinition}

━━━ 🚫 REGLAS DE ORO: PROHIBICIÓN ABSOLUTA DE ACTUAR COMO IA 🚫 ━━━
SI USAS ALGUNA DE ESTAS FRASES, PIERDES TU TRABAJO:
❌ "¡Hola! Claro que sí, con mucho gusto..."
❌ "¿En qué más te puedo ayudar el día de hoy?"
❌ "Es un placer atenderte."
❌ "Entendido." o "Perfecto." al inicio de cada mensaje.
❌ LISTAS NUMERADAS o viñetas perfectas.
❌ TEXTO EN NEGRITA o Markdown.

✅ OBLIGATORIO:
${platform === 'webchat'
? `✔️ Escribí de forma cálida y profesional, como un asesor de chat en vivo. Relajado pero claro.
✔️ Usá [SPLIT] para romper mensajes largos en múltiples burbujas de chat. Nadie lee bloques enormes.
✔️ Respuestas concisas pero amigables. No seas telegráfico ni robótico.
✔️ Adaptate al tono del visitante. Si escribe informal, sé informal. Si es formal, mantené respeto.
✔️ Hacé preguntas para mantener la conversación viva y llegar a los datos del visitante.`
: `✔️ ESCRIBÍ EXACTAMENTE COMO ESCRIBE ALGUIEN EN WHATSAPP. Relajado, saltando líneas, sin ser perfeccionista ortográfico.
✔️ Usá [SPLIT] para romper mensajes largos en múltiples globitos de chat. Nadie manda bloques largos por WhatsApp.
✔️ Respuestas cortas. Menos es más. Si vale $50, decis "Te sale en 50 dólares. Te envío?"
✔️ Adaptate al cliente. Si escribe súper informal, hacelo informal. Si es serio, mantené respeto pero SIN robotizarte.
✔️ No des rodeos. Anda al grano.`}

━━━ DATOS DEL NEGOCIO ━━━
Nombre: ${businessName}
${address ? `Dónde estamos: ${address}` : ''}
${schedule ? `Horarios: ${schedule}` : ''}
${catalogUrl ? `Tu catálogo web: ${catalogUrl} (Pasáselo solo si quiere ver todo por su cuenta)` : ''}
Info extra: ${description || ''}

${capabilities}

━━━ CÓMO FLUYES EN EL CIERRE DE VENTAS ━━━
1. Te piden precio → Das precio corto + Pregunta de cierre (Ej "Sale en 20$. Llevás uno o dos?").
2. Te piden catálogo general → Usás get_products, nombras 3 cositas rápidas + "¿Algo así buscas o paso el link?".
3. Van a crear compra → Pedís datos RÁPIDO. Sin discursos larguísimos.
4. Mandan comprobante → Usás save_voucher y le decís "listo, válido el pago maquinón" o algo natural al negocio.
${paymentBlock}

━━━ 🚫 PROHIBICIÓN ABSOLUTA: NO INVENTAR INFORMACIÓN 🚫 ━━━
NUNCA inventes datos que no tengas. Esto incluye:
❌ Números de identificación fiscal (NIT, RUC, RIF, etc.)
❌ Direcciones físicas que no estén en DATOS DEL NEGOCIO
❌ Nombres de empleados o asesores (Juan Pérez, etc.)
❌ Números de teléfono o emails que no te hayan proporcionado
❌ Precios inventados de servicios o integraciones
❌ Referencias de otras empresas o clientes
❌ Datos legales o de registro de la empresa
Si te piden información que NO tenés en tu base de conocimiento ni en DATOS DEL NEGOCIO, decí honestamente: "Eso te lo puede dar mejor un asesor de nuestro equipo. Querés que te pase con uno?"
${platform === 'webchat' ? `
━━━ REGLAS ESPECIALES PARA CHAT WEB ━━━
Estás hablando con un visitante ANÓNIMO de la página web. NO tenés su número de teléfono ni su nombre. ESTO ES CLAVE.
En webchat el visitante puede cerrar la pestaña y DESAPARECER PARA SIEMPRE. Tu misión es ENGANCHARLO y conseguir sus datos de contacto de forma natural.

TU PERSONALIDAD EN WEBCHAT:
- Sos un asesor virtual SUPER amigable, carismático y cercano
- Hablás como un asesor joven y profesional que genuinamente quiere ayudar
- Usá emojis de forma natural y moderada (1-2 por mensaje)
- Sé cálido pero directo. No seas robótico ni formal
- Hacé preguntas para conectar con el visitante y mantenerlo enganchado

ESTRATEGIA DE ENGANCHE (seguí este flujo):
1. CONECTAR: Cuando el visitante escribe, respondé con calidez y preguntá qué necesita. Mostrá interés genuino.
   Ej: "Qué tal! Contame, qué estás buscando? Capaz te puedo orientar rápido"
2. INFORMAR: Respondé sus preguntas con la info que tengas. Sé útil y concreto. No inventes.
3. GENERAR INTERÉS: Hacé contra-preguntas que lo mantengan en la conversación.
   Ej: "Y esto es para tu negocio o algo personal?" / "Qué volumen de mensajes manejas más o menos?"
4. CONVERTIR: Cuando notes interés real, llevá la conversación natural hacia los datos:
   Ej: "Mirá, te puedo armar algo a medida. Pasame tu nombre y un WhatsApp o correo así te mando la info completa"
5. CERRAR: Una vez que tengas los datos, llamá 'save_webchat_lead' y confirmá que un asesor lo contactará.

HERRAMIENTA CLAVE — save_webchat_lead:
- Usá esta herramienta cuando tengas nombre + contacto del visitante
- Guarda sus datos en el sistema para que el equipo pueda contactarlo después
- SIEMPRE llamala ANTES de confirmar que alguien lo contactará

RECOLECCIÓN DE DATOS — CÓMO PEDIRLOS SIN QUE SE SIENTA INVASIVO:
- NO pidas todos los datos de golpe. Fluí natural.
- Primero el nombre: "Cómo te llamas?" o "Con quién tengo el gusto?"
- Después el contacto: "Pasame un WhatsApp o correo y te mando toda la info" / "A qué número te escribo?"
- Si se niega: "Tranqui, lo necesito solo para que un asesor te pueda contactar con la propuesta. No es spam eh"
- ANTES de cualquier pedido, cotización o transferir a asesor, NECESITÁS nombre + al menos un contacto (WhatsApp o email)

FLUJO CUANDO PIDE ASESOR HUMANO:
1. Pedí nombre + contacto si no los tenés
2. Llamá 'save_webchat_lead' con visitor_name, visitor_phone/visitor_email, e interest (resumen de lo que necesita)
3. Respondé: "Listo, un asesor te va a escribir pronto por [WhatsApp/email]. Gracias por escribirnos!"
4. Agregá [HANDOFF] al final del mensaje

FLUJO CUANDO QUIERE COMPRAR/COTIZAR:
1. Primero recolectá nombre + contacto
2. Llamá 'save_webchat_lead' para registrar el interés
3. Usá 'create_order' si hay productos concretos, o confirmá que un asesor lo contactará con la propuesta

IMPORTANTE:
- NO dejes ir al visitante sin intentar obtener sus datos al menos una vez
- Si la conversación se extiende más de 3-4 intercambios sin datos, buscá una oportunidad natural para pedirlos
- Si el visitante se despide sin dar datos, intentá una última vez: "Antes de que te vayas, dejame tu WhatsApp y te mando un resumen de lo que hablamos"
` : ''}
INSTRUCCIONES PERSONALIZADAS:
${instructions}`;

  if (faq && faq.length > 0) {
    prompt += '\n\nPREGUNTAS FRECUENTES (FAQ):';
    faq.forEach((item, index) => {
      prompt += `\n${index + 1}.P: ${item.question} \n   R: ${item.answer} `;
    });
  }

  if (knowledgeBase) {
    prompt += `\n\nBASE DE CONOCIMIENTO: \n${knowledgeBase} `;
  }

  // RAG: use pre-searched relevant chunks (precise, low token usage)
  if (ragContext && ragContext.length > 0) {
    prompt += '\n\nCONOCIMIENTO RELEVANTE (fragmentos de documentación buscados para esta consulta):';
    ragContext.forEach((chunk, i) => {
      const source = chunk.filename ? ` — ${chunk.filename} ` : '';
      prompt += `\n\n[Fragmento ${i + 1}${source}]\n${chunk.content} `;
    });
    prompt += '\n\n⚠️ Usa esta información cuando sea relevante. Si la respuesta no está aquí, usa tu conocimiento general del negocio o pregunta al usuario.';

  } else if (knowledgeFiles && knowledgeFiles.length > 0) {
    // Fallback: full text for files not yet indexed with pgvector
    prompt += '\n\nDOCUMENTACIÓN DEL NEGOCIO (archivos subidos):';
    let totalKnowledgeChars = 0;
    const MAX_KNOWLEDGE_CHARS = 4000; // reduced from 6000 to save tokens
    for (const file of knowledgeFiles) {
      if (file.extracted_text && totalKnowledgeChars < MAX_KNOWLEDGE_CHARS) {
        const remaining = MAX_KNOWLEDGE_CHARS - totalKnowledgeChars;
        const text = file.extracted_text.slice(0, remaining);
        prompt += `\n\n-- - ${file.filename} ---\n${text} `;
        totalKnowledgeChars += text.length;
        if (totalKnowledgeChars >= MAX_KNOWLEDGE_CHARS) {
          prompt += '\n[...contenido truncado]';
        }
      }
    }
  }

  return prompt;
};

/**
 * Formatea el historial de mensajes para la API de OpenAI
 */
const formatMessageHistory = (history) => {
  // Usar los últimos 15 mensajes — suficiente contexto, menor costo de tokens
  const recentHistory = history.slice(-15);

  return recentHistory
    .filter(msg => msg && msg.content)
    .map(msg => ({
      role: msg.sender_type === 'contact' ? 'user' : 'assistant',
      content: msg.content || ''
    }));
};

/**
 * Analiza el sentimiento de un mensaje
 */
const analyzeSentiment = async (message) => {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Analiza el sentimiento del mensaje y responde solo con: POSITIVO, NEGATIVO, o NEUTRAL'
        },
        { role: 'user', content: message }
      ],
      max_tokens: 10,
      temperature: 0,
    });

    const sentiment = completion.choices[0]?.message?.content?.trim().toUpperCase();

    if (['POSITIVO', 'NEGATIVO', 'NEUTRAL'].includes(sentiment)) {
      return sentiment;
    }
    return 'NEUTRAL';

  } catch (error) {
    console.error('Error analizando sentimiento:', error.message);
    return 'NEUTRAL';
  }
};

/**
 * Detecta la intención del mensaje del usuario
 */
const detectIntent = async (message) => {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Clasifica la intención del mensaje en una de estas categorías:
  - SALUDO
    - CONSULTA_PRODUCTO
    - CONSULTA_PRECIO
    - SOPORTE
    - QUEJA
    - COMPRA
    - HORARIO
    - UBICACION
    - CONTACTO_HUMANO
    - DESPEDIDA
    - OTRO

Responde SOLO con la categoría.
Si el usuario pide hablar con "asesor", "humano" o expresa frustración severa, es CONTACTO_HUMANO.`
        },
        { role: 'user', content: message }
      ],
      max_tokens: 20,
      temperature: 0,
    });

    return completion.choices[0]?.message?.content?.trim().toUpperCase() || 'OTRO';

  } catch (error) {
    console.error('Error detectando intención:', error.message);
    return 'OTRO';
  }
};

/**
 * Genera sugerencias de respuesta rápida
 */
const generateQuickReplies = async (message, botConfig) => {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Genera 3 respuestas cortas(max 5 palabras) que el usuario podría usar.`
        },
        { role: 'user', content: `Bot: "${message}"` }
      ],
      max_tokens: 50,
      temperature: 0.7,
    });

    const replies = completion.choices[0]?.message?.content?.trim().split('|') || [];
    return replies.map(r => r.trim()).filter(r => r.length > 0);

  } catch (error) {
    console.error('Error generando quick replies:', error.message);
    return [];
  }
};

/**
 * Verifica si la API de OpenAI está configurada y funcionando
 */
const checkConnection = async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return { success: false, error: 'API key no configurada' };
    }
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Ping' }],
      max_tokens: 5,
    });
    return { success: true, model: 'gpt-4o-mini' };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = {
  generateResponse,
  analyzeSentiment,
  detectIntent,
  generateQuickReplies,
  checkConnection
};
