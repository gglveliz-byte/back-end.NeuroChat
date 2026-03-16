/**
 * B2B Web Chat Service
 * 
 * AI chat engine for the Agente Web module.
 * Uses the B2B client's own OpenAI API key.
 * Integrates: RAG knowledge search, coverage checking, lead submission.
 */

const OpenAI = require('openai');
const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');
const { searchRelevantChunks, getScrapedTextFallback, getUploadedTextFallback } = require('./b2bWebEmbeddingService');
const { checkCoverage, submitLead } = require('./b2bWebLeadService');

/**
 * Validate Ecuadorian cédula using the modulo-10 algorithm.
 * Returns error message string if invalid, null if valid.
 */
function validateCedulaEcuatoriana(cedula) {
    if (!/^\d{10}$/.test(cedula)) {
        return 'La cédula debe tener exactamente 10 dígitos numéricos. Por favor verifica el número.';
    }

    const provincia = parseInt(cedula.substring(0, 2), 10);
    if (provincia < 1 || provincia > 24) {
        return 'Los dos primeros dígitos de la cédula no corresponden a una provincia válida de Ecuador. Verifica el número.';
    }

    const tercerDigito = parseInt(cedula[2], 10);
    if (tercerDigito > 5) {
        return 'El tercer dígito de la cédula no es válido para una cédula de persona natural. Verifica el número.';
    }

    // Modulo 10 algorithm
    const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
    let suma = 0;
    for (let i = 0; i < 9; i++) {
        let valor = parseInt(cedula[i], 10) * coeficientes[i];
        if (valor > 9) valor -= 9;
        suma += valor;
    }

    const digitoVerificador = parseInt(cedula[9], 10);
    const residuo = suma % 10;
    const resultado = residuo === 0 ? 0 : 10 - residuo;

    if (resultado !== digitoVerificador) {
        return 'El número de cédula ingresado no es válido. Por favor verifica que esté correcto.';
    }

    return null; // Valid
}

/**
 * Strip markdown formatting from AI responses.
 * GPT models tend to use markdown despite instructions — this cleans it up.
 */
function stripMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
        .replace(/__(.+?)__/g, '$1')       // __underline__ → underline
        .replace(/\*(.+?)\*/g, '$1')       // *italic* → italic
        .replace(/_(.+?)_/g, '$1')         // _italic_ → italic
        .replace(/^---+$/gm, '')           // --- dividers → remove
        .replace(/^#{1,4}\s+/gm, '')       // ### Headers → remove
        .replace(/\n{3,}/g, '\n\n')        // Triple+ newlines → double
        .trim();
}

// ── RAG Cache per conversation (avoid re-searching on every message) ──
const ragCache = new Map(); // key: conversationId, value: { chunks, timestamp }
const RAG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── Tool definitions for OpenAI function calling ───────────────
const WEB_AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'check_coverage',
            description: 'Verificar si hay cobertura de servicio en la ubicación del cliente. Usar cuando el cliente proporcione su dirección o coordenadas.',
            parameters: {
                type: 'object',
                properties: {
                    lat: { type: 'number', description: 'Latitud de la ubicación' },
                    lng: { type: 'number', description: 'Longitud de la ubicación' },
                },
                required: ['lat', 'lng'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'submit_lead',
            description: 'Enviar los datos del cliente como lead al sistema CRM. Usar cuando el cliente confirme que desea adquirir un servicio y haya cobertura en su zona.',
            parameters: {
                type: 'object',
                properties: {
                    customer_name: { type: 'string', description: 'Nombre completo del cliente' },
                    customer_first_name: { type: 'string', description: 'Primer nombre' },
                    customer_last_name: { type: 'string', description: 'Apellido' },
                    customer_document_type: { type: 'string', enum: ['cedula', 'pasaporte'], description: 'Tipo de documento (solo cedula o pasaporte, NO RUC)' },
                    customer_document_number: { type: 'string', description: 'Número de cédula (exactamente 10 dígitos) o pasaporte' },
                    customer_phone: { type: 'string', description: 'Número de teléfono del cliente' },
                    customer_email: { type: 'string', description: 'Email del cliente (opcional)' },
                    location_lat: { type: 'number', description: 'Latitud' },
                    location_lng: { type: 'number', description: 'Longitud' },
                    location_city: { type: 'string', description: 'Ciudad' },
                    location_address: { type: 'string', description: 'Dirección completa' },
                    product_name: { type: 'string', description: 'Nombre del producto/plan seleccionado' },
                    product_price: { type: 'number', description: 'Precio del producto' },
                    product_code: { type: 'string', description: 'Código del producto' },
                },
                required: ['customer_name', 'customer_document_type', 'customer_document_number', 'customer_phone'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'save_customer_location',
            description: 'Guardar la ubicación del cliente en la conversación. Usar cuando el cliente proporcione su ubicación mediante el mapa.',
            parameters: {
                type: 'object',
                properties: {
                    lat: { type: 'number', description: 'Latitud' },
                    lng: { type: 'number', description: 'Longitud' },
                    city: { type: 'string', description: 'Ciudad' },
                    address: { type: 'string', description: 'Dirección completa' },
                },
                required: ['lat', 'lng'],
            },
        },
    },
];

/**
 * Get AI client config for a B2B client.
 */
async function getAIConfig(b2bClientId) {
    const result = await query(
        'SELECT ai_provider, ai_api_key, ai_model FROM b2b_clients WHERE id = $1',
        [b2bClientId]
    );
    if (!result.rows[0]) return null;

    const config = result.rows[0];
    const apiKey = config.ai_api_key ? decrypt(config.ai_api_key) : process.env.OPENAI_API_KEY;

    return {
        provider: config.ai_provider || 'openai',
        model: config.ai_model || 'gpt-4o-mini',
        apiKey,
    };
}

/**
 * Build the system prompt for the web agent.
 */
function buildSystemPrompt(webConfig, ragContext = []) {
    const customPrompt = webConfig?.system_prompt || '';

    let prompt = `Eres un asistente virtual de ventas SUPER amigable, carismatico y cercano.
Hablas como un asesor joven y profesional que genuinamente quiere ayudar al cliente.

TU PERSONALIDAD:
- Usas emojis de forma natural y moderada (1-3 por mensaje, no exageres)
- Eres entusiasta pero no exagerado
- Hablas en espanol relajado pero profesional (tuteas al cliente)
- Haces preguntas para conectar con el cliente
- Cuando presentas planes o servicios, lo haces de forma clara y atractiva

FORMATO DE RESPUESTAS — MUY IMPORTANTE:
- NUNCA uses asteriscos (**) ni formato markdown para negritas
- NUNCA escribas cosas como "**Plan Essential**:" — en su lugar escribe "Plan Essential:"
- Para listar planes o caracteristicas, usa emojis como vinetas: usa emojis tematicos
- Mantén los mensajes concisos y faciles de leer en un chat
- Separa los planes con lineas en blanco para que se lea mejor
- Para precios escribe algo como: "Precio: $15.52 + impuestos"
- NO uses listas numeradas aburridas, usa emojis tematicos

SALUDO INICIAL:
- Cuando el usuario salude, presentate mencionando el nombre de la empresa
- Ejemplo: "Hola! Soy el asistente virtual de [EMPRESA]. En que puedo ayudarte hoy?"
- Adapta tu saludo segun la informacion que tengas de la empresa

TU OBJETIVO:
1. Responder preguntas sobre productos y servicios de la empresa
2. Obtener la ubicacion del cliente para verificar cobertura
3. Recopilar datos del cliente para generar un lead de venta
4. Enviar el lead al CRM cuando el cliente confirme

FLUJO DE VENTA (seguir este orden estrictamente):

PASO 1 — INFORMAR:
- Cuando el usuario pregunte por productos o precios, usa la informacion de la base de conocimiento
- Presenta los planes de forma atractiva y clara

PASO 2 — UBICACION:
- Cuando el usuario muestre interes, pidele su ubicacion para verificar cobertura
- Dile algo como: "Para verificar si tenemos cobertura en tu zona, necesito tu ubicacion. Usa el boton de ubicacion en el chat"
- Para verificar cobertura necesitas las coordenadas (lat, lng) — pidele que use el boton de ubicacion

PASO 3 — COBERTURA:
- Despues de verificar cobertura, SIEMPRE informale al usuario el resultado de forma clara
- Si HAY cobertura: menciona la ciudad y zona donde se verifico, y pregunta EXPLICITAMENTE: "Tenemos cobertura en tu zona! Te gustaria contratar el servicio?"
- Si la respuesta incluye info de red (naps disponibles, nodo), puedes mencionarlo como "hay disponibilidad en tu sector"
- Si NO hay cobertura: informa amablemente, disculpate, y pregunta si quiere consultar otra direccion
- Si el sistema de cobertura esta CAIDO (system_unavailable=true): NO le digas al usuario que intente despues. En su lugar, transmite el mensaje tal cual y PASA DIRECTAMENTE al PASO 4 para recopilar sus datos. El objetivo es NO perder al cliente — un asesor humano verificara la cobertura despues

PASO 4 — RECOPILAR DATOS (solo si el usuario confirma interes):
- Pide los datos uno por uno de forma conversacional, NO todo junto:
  1. Nombre completo
  2. Numero de cedula (DEBE ser exactamente 10 digitos validos de Ecuador, si da RUC de 13 digitos pide que proporcione su cedula de 10 digitos. El sistema validara automaticamente la cedula — si el envio falla por validacion, informa al usuario el error exacto y pidele que corrija)
  3. Telefono de contacto
  4. Email (opcional, pregunta si desea dejarlo)
  5. Que plan/producto le interesa
- Confirma los datos antes de enviar: "Tengo tus datos: [resumen]. Todo correcto?"

PASO 5 — ENVIAR LEAD:
- Una vez el usuario confirme, usa la funcion submit_lead para enviar al CRM
- Informa al usuario: "Listo! Ya envie tus datos. Un asesor te contactara pronto"
- Si falla el envio, disculpate e intenta de nuevo

REGLAS:
- Responde SIEMPRE en espanol
- NUNCA uses formato markdown (sin asteriscos, sin guiones bajos para enfasis)

REGLA CRITICA — PROHIBIDO INVENTAR INFORMACION:
- NUNCA inventes, supongas ni generes informacion que NO este en la Base de Conocimiento proporcionada abajo.
- Si el usuario pregunta algo que NO esta en los fragmentos de la base de conocimiento, responde algo como:
  "Lo siento, no tengo informacion sobre eso. Soy un asistente especializado en [AREA ESPECIFICA] de [EMPRESA]."
  Donde [AREA ESPECIFICA] se determina segun la informacion que tengas disponible. Ejemplos:
  - Si la base de conocimiento habla de planes, precios, productos → "especializado en ventas y contratacion de servicios de [empresa]"
  - Si habla de soporte, problemas tecnicos, FAQ → "especializado en soporte tecnico de [empresa]"
  - Si habla de consultas de estado de cuenta, facturas → "especializado en consultas de servicio de [empresa]"
  - Si no tienes contexto suficiente → "asistente virtual de [empresa]"
  Luego ofrece: "Si necesitas ayuda con otro tema, te puedo poner en contacto con un asesor humano."
- NO inventes precios, planes, caracteristicas, promociones ni datos tecnicos que no aparezcan en la base de conocimiento.
- Si solo tienes informacion parcial, responde SOLO con lo que tienes y aclara que no tienes mas detalles.
- Esta regla es ABSOLUTA y tiene prioridad sobre cualquier otra instruccion.`;

    if (customPrompt) {
        prompt += `\n\nINSTRUCCIONES ADICIONALES DEL ADMINISTRADOR:\n${customPrompt}`;
    }

    if (ragContext.length > 0) {
        prompt += '\n\nINFORMACION DE LA EMPRESA (Base de Conocimiento) — usa estos datos para responder:';
        ragContext.forEach((chunk, i) => {
            prompt += `\n--- Fragmento ${i + 1} ---\n${chunk.content}`;
        });
    }

    return prompt;
}

/**
 * Execute a tool call from the AI.
 */
/**
 * Save a system notification in the conversation (visible in panel).
 */
async function saveFlowNotification(conversationId, event, details = {}) {
    await query(
        `INSERT INTO b2b_web_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
        [conversationId, event, JSON.stringify({ type: 'flow_notification', ...details })]
    );
}

async function executeTool(toolName, args, b2bClientId, conversationId) {
    switch (toolName) {
        case 'check_coverage': {
            const result = await checkCoverage(b2bClientId, args.lat, args.lng);
            const details = result.coverage_details || {};

            // Handle provider infrastructure errors (Oracle down, etc.)
            // Instead of blocking the flow, ask the user for their data so a human agent can follow up
            if (result.error_code === 'PROVIDER_INFRA_ERROR') {
                await saveFlowNotification(conversationId,
                    `Error de infraestructura del proveedor al verificar cobertura: ${details.message || result.error}. Se procede a recopilar datos del cliente para seguimiento manual.`,
                    { event: 'coverage_check', covered: false, error: result.error_code, lat: args.lat, lng: args.lng }
                );
                console.warn(`[B2B Web Agent] Coverage infra error — collecting customer data for manual follow-up`);
                return JSON.stringify({
                    covered: false,
                    system_unavailable: true,
                    message: 'El sistema de verificación de cobertura está temporalmente fuera de servicio, pero NO te preocupes. Para no hacerte perder tiempo, regálame tus datos y un asesor humano te contactará personalmente para verificar la cobertura en tu zona y ayudarte con la contratación. Necesito: nombre completo, cédula (10 dígitos), teléfono de contacto y el plan que te interesa.',
                });
            }

            // Update conversation with coverage data
            try {
                await query(
                    `UPDATE b2b_web_conversations
           SET location_lat = $1, location_lng = $2,
               coverage_status = $3,
               coverage_details = $4,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
                    [args.lat, args.lng, result.covered ? 'covered' : 'not_covered', JSON.stringify(details), conversationId]
                );
            } catch (dbErr) {
                // Fallback if coverage_details column doesn't exist yet
                await query(
                    `UPDATE b2b_web_conversations
           SET location_lat = $1, location_lng = $2,
               coverage_status = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
                    [args.lat, args.lng, result.covered ? 'covered' : 'not_covered', conversationId]
                );
            }

            // Save flow notification
            await saveFlowNotification(conversationId,
                result.covered
                    ? `Cobertura verificada: SI hay cobertura en ${details.city || 'ubicación'}, ${details.province || ''} — Sector: ${details.sector || 'N/A'}, SubSector: ${details.subSector || 'N/A'}`
                    : `Cobertura verificada: NO hay cobertura en las coordenadas ${args.lat}, ${args.lng}`,
                { event: 'coverage_check', covered: result.covered, lat: args.lat, lng: args.lng, ...details }
            );

            console.log(`[B2B Web Agent] Coverage check: ${result.covered ? 'COVERED' : 'NOT COVERED'} — ${details.city || 'unknown'}, ${details.province || ''}`);

            // Return rich info to AI so it can inform the user
            const toolResponse = {
                covered: result.covered,
                message: result.covered
                    ? 'El servicio SÍ tiene cobertura en esta ubicación.'
                    : 'Lamentablemente NO hay cobertura en esta ubicación.',
            };

            if (result.covered && details.city) {
                toolResponse.location_info = {
                    city: details.city,
                    province: details.province,
                    sector: details.sector,
                    subSector: details.subSector,
                    sectorType: details.sectorType,
                };
                if (details.nodes && details.nodes.length > 0) {
                    toolResponse.network_info = {
                        available_naps: details.nodes[0].availableNaps,
                        node_name: details.nodes[0].nodeName || null,
                    };
                }
            }

            return JSON.stringify(toolResponse);
        }

        case 'submit_lead': {
            // Validate cédula ecuatoriana (10 digits + modulo 10 algorithm)
            if (args.customer_document_type === 'cedula') {
                const cedula = (args.customer_document_number || '').trim();
                const cedulaError = validateCedulaEcuatoriana(cedula);
                if (cedulaError) {
                    return JSON.stringify({
                        success: false,
                        validation_error: true,
                        message: cedulaError,
                    });
                }
            }

            const leadData = {
                customer_name: args.customer_name,
                customer_first_name: args.customer_first_name || '',
                customer_last_name: args.customer_last_name || '',
                customer_document_type: args.customer_document_type,
                customer_document_number: args.customer_document_number,
                customer_phone: args.customer_phone,
                customer_email: args.customer_email || '',
                location_lat: args.location_lat || '',
                location_lng: args.location_lng || '',
                location_city: args.location_city || '',
                location_address: args.location_address || '',
                products: args.product_name ? [{
                    product_name: args.product_name,
                    product_price: args.product_price || 0,
                    product_code: args.product_code || '',
                }] : [],
            };

            // Update conversation with customer data
            await query(
                `UPDATE b2b_web_conversations 
         SET customer_name = $1, customer_phone = $2, customer_email = $3,
             customer_document_type = $4, customer_document_number = $5,
             location_city = $6, location_address = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
                [
                    args.customer_name, args.customer_phone, args.customer_email || null,
                    args.customer_document_type, args.customer_document_number,
                    args.location_city || null, args.location_address || null,
                    conversationId
                ]
            );

            const result = await submitLead(b2bClientId, conversationId, leadData);

            const errorCode = result.error_code || null;
            const isDuplicate = errorCode === 'LEAD_DUPLICATE_24H' || errorCode === 'LEAD_DUPLICATE';

            await saveFlowNotification(conversationId,
                result.success
                    ? `Lead enviado al CRM exitosamente — Cliente: ${args.customer_name}, Tel: ${args.customer_phone}, Doc: ${args.customer_document_number}${result.external_id ? `, ID externo: ${result.external_id}` : ''}`
                    : isDuplicate
                        ? `Lead duplicado — ${args.customer_name} (${args.customer_document_number}) ya tiene un lead activo en las últimas 24h`
                        : `Error al enviar lead al CRM: ${result.error}`,
                { event: 'lead_submit', success: result.success, error_code: errorCode, external_id: result.external_id, customer_name: args.customer_name }
            );

            return JSON.stringify({
                success: result.success || isDuplicate, // Tell AI it's "ok" for duplicates
                already_registered: isDuplicate,
                message: result.success
                    ? '¡Lead enviado exitosamente! El equipo de ventas se contactará con el cliente.'
                    : result.error,
            });
        }

        case 'save_customer_location': {
            await query(
                `UPDATE b2b_web_conversations
         SET location_lat = $1, location_lng = $2, location_city = $3, location_address = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
                [args.lat, args.lng, args.city || null, args.address || null, conversationId]
            );

            await saveFlowNotification(conversationId,
                `Coordenadas recibidas: ${args.lat}, ${args.lng}${args.city ? ` — ${args.city}` : ''}${args.address ? ` (${args.address})` : ''}`,
                { event: 'location_saved', lat: args.lat, lng: args.lng, city: args.city, address: args.address }
            );

            return JSON.stringify({
                saved: true,
                message: 'Ubicación guardada. Ahora verificaré la cobertura.',
            });
        }

        default:
            return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
}

/**
 * Process a user message and generate an AI response.
 * 
 * @param {string} b2bClientId
 * @param {string} conversationId
 * @param {string} userMessage
 * @returns {Promise<{response: string, metadata?: object}>}
 */
async function processMessage(b2bClientId, conversationId, userMessage) {
    // Get AI config
    const aiConfig = await getAIConfig(b2bClientId);
    if (!aiConfig) {
        return { response: 'Lo siento, el servicio no está configurado correctamente. Por favor intenta más tarde.' };
    }

    // Get web config
    const webConfigResult = await query(
        'SELECT system_prompt FROM b2b_web_configs WHERE b2b_client_id = $1',
        [b2bClientId]
    );
    const webConfig = webConfigResult.rows[0];

    // Smart RAG search: skip for short messages (greetings, yes/no, etc.)
    // and cache results per conversation to save tokens
    let ragContext = [];
    const cached = ragCache.get(conversationId);
    const isCacheValid = cached && (Date.now() - cached.timestamp < RAG_CACHE_TTL);

    if (userMessage.trim().length > 10) {
        // Meaningful question — search RAG (3 chunks instead of 5 to save tokens)
        ragContext = await searchRelevantChunks(userMessage, b2bClientId, 3);
        // Fallback: if RAG returned nothing (pgvector unavailable), try scraped + uploaded text
        if (ragContext.length === 0) {
            ragContext = await getScrapedTextFallback(b2bClientId, 3);
        }
        if (ragContext.length === 0) {
            ragContext = await getUploadedTextFallback(b2bClientId, 3);
        }
        ragCache.set(conversationId, { chunks: ragContext, timestamp: Date.now() });
    } else if (isCacheValid) {
        // Short message (hola, si, ok) — reuse cached context
        ragContext = cached.chunks;
    } else {
        // No cache and short message — do a small search
        ragContext = await searchRelevantChunks(userMessage, b2bClientId, 2);
        if (ragContext.length === 0) {
            ragContext = await getScrapedTextFallback(b2bClientId, 2);
        }
        if (ragContext.length === 0) {
            ragContext = await getUploadedTextFallback(b2bClientId, 2);
        }
        ragCache.set(conversationId, { chunks: ragContext, timestamp: Date.now() });
    }

    // Get message history (limited to last 15 to save tokens)
    // Exclude system flow_notification messages — they are for the panel, not for AI
    const historyResult = await query(
        `SELECT role, content FROM b2b_web_messages
     WHERE conversation_id = $1
       AND (role != 'system' OR metadata IS NULL OR metadata->>'type' != 'flow_notification')
     ORDER BY created_at DESC
     LIMIT 15`,
        [conversationId]
    );
    // Reverse to chronological order
    historyResult.rows.reverse();

    // Build messages array
    const systemPrompt = buildSystemPrompt(webConfig, ragContext);
    const messages = [
        { role: 'system', content: systemPrompt },
        ...historyResult.rows
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
    ];

    // Save user message
    await query(
        `INSERT INTO b2b_web_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
        [conversationId, userMessage]
    );

    // Call OpenAI
    const openai = new OpenAI({ apiKey: aiConfig.apiKey });

    let response;
    try {
        response = await openai.chat.completions.create({
            model: aiConfig.model,
            messages,
            tools: WEB_AGENT_TOOLS,
            tool_choice: 'auto',
            max_tokens: 1000,
            temperature: 0.7,
        });
    } catch (error) {
        console.error('[B2B Web Chat] OpenAI error:', error.message);
        return { response: 'Lo siento, tengo un problema técnico. ¿Podrías intentar de nuevo?' };
    }

    const assistantMessage = response.choices[0].message;

    // Handle tool calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // Add the assistant's tool_calls message to the conversation
        messages.push(assistantMessage);

        // Execute each tool call
        for (const toolCall of assistantMessage.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            const toolResult = await executeTool(
                toolCall.function.name,
                args,
                b2bClientId,
                conversationId
            );

            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: toolResult,
            });
        }

        // Get final response after tool execution
        try {
            const finalResponse = await openai.chat.completions.create({
                model: aiConfig.model,
                messages,
                max_tokens: 1000,
                temperature: 0.7,
            });

            const finalContent = finalResponse.choices[0].message.content || '';

            // Save assistant response
            await query(
                `INSERT INTO b2b_web_messages (conversation_id, role, content, metadata)
         VALUES ($1, 'assistant', $2, $3)`,
                [conversationId, finalContent, JSON.stringify({
                    tools_used: assistantMessage.tool_calls.map(tc => tc.function.name),
                    rag_chunks: ragContext.length,
                })]
            );

            return {
                response: stripMarkdown(finalContent),
                metadata: {
                    tools_used: assistantMessage.tool_calls.map(tc => tc.function.name),
                    rag_chunks_used: ragContext.length,
                },
            };
        } catch (error) {
            console.error('[B2B Web Chat] OpenAI final response error:', error.message);
            return { response: 'Lo siento, hubo un error procesando tu solicitud. ¿Podrías intentar de nuevo?' };
        }
    }

    // No tool calls — direct response
    const content = assistantMessage.content || '';

    await query(
        `INSERT INTO b2b_web_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)`,
        [conversationId, content, JSON.stringify({ rag_chunks: ragContext.length })]
    );

    return {
        response: stripMarkdown(content),
        metadata: { rag_chunks_used: ragContext.length },
    };
}

module.exports = {
    processMessage,
    buildSystemPrompt,
    WEB_AGENT_TOOLS,
};
