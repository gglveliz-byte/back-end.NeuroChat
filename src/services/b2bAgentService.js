const OpenAI = require('openai');
const axios = require('axios');
const { decrypt } = require('../utils/encryption');

// ─── B2B AI Agent Service v2 ──────────────────────────────────
// Multi-provider AI service (OpenAI / Gemini) for B2B quality agents.
// Each B2B client brings their own API key and model choice.
//
// Prompt architecture (5 layers):
//   Layer 1: FIXED_QUALITY_PROMPT (code — never editable)
//   Layer 2: agent.description (editable — what this agent does)
//   Layer 3: agent.evaluation_template (editable — criteria to evaluate)
//   Layer 4: agent.deliverable_template (editable — output format)
//   Layer 5: agent.feedback_accumulated (grows from rejections)

// ─── LAYER 1: FIXED PROMPT (MANDATORY — never editable) ──────
const FIXED_QUALITY_PROMPT = `Eres un Auditor Senior de Calidad de Experiencia al Cliente con +15 años de experiencia real en call centers de todo el mundo (Latam, España, USA). 

NO eres un robot. Eres un experto humano con criterio propio, intuición y sentido común.

═══ FILOSOFÍA DE AUDITORÍA (NUNCA NEGOCIABLE) ═══
1. PROTOCOLO DE RAZONAMIENTO OBLIGATORIO: Para cada decisión crítica, sigue estos 4 pasos:
   a) EXPLICAR LA REGLA: ¿Qué pide exactamente el criterio?
   b) BUSCAR EVIDENCIA: Cita la frase exacta o momento de la transcripción/métricas.
   c) DECIDIR: ¿Cumple el objetivo de fondo (espíritu) de la interacción?
   d) JUSTIFICAR: Explica tu lógica CX detrás de la nota.

2. AUTONOMÍA Y CRITERIO PROPIO:
   - La plantilla del cliente es TU GUÍA, pero NO tu cárcel.
   - Si detectas algo crítico que la plantilla NO cubre (riesgo legal, empatía falsa, cliente a punto de cancelar, etc.) → EVALÚALO y documéntalo.

3. EVIDENCIA + INFERENCIA JUSTA:
   - Nunca alucines. Usa las MÉTRICAS DE AUDIO para confirmar lo que el texto no dice (ej: "Hay una pausa de 10s antes del saludo, infiero desatención").

4. INTERPRETACIÓN FLEXIBLE — PIENSA COMO HUMANO, NO COMO ROBOT:
   - Evalúa la INTENCIÓN y el RESULTADO, no las palabras exactas.
   - Cada asesor tiene su estilo. Si el criterio dice "Saludo cordial" y el asesor dice "Hola, buenas tardes, le habla María, ¿en qué le puedo ayudar?" eso CUMPLE aunque no diga textualmente "buenos días, bienvenido a [empresa]".
   - Pregúntate: "¿Un supervisor humano con sentido común diría que este asesor cumplió?" Si la respuesta es SÍ → marca CUMPLE.
   - NO penalices por variaciones de estilo, sinónimos, o formas equivalentes de cumplir un protocolo.
   - SÍ penaliza cuando genuinamente NO se cumple el objetivo del criterio (omisión real, error grave, falta de información crítica).
   - EJEMPLOS DE FLEXIBILIDAD:
     • "Verificar identidad del cliente" → CUMPLE si pidió cédula, nombre, número de cuenta, o cualquier dato que confirme identidad, aunque no use las palabras exactas del protocolo.
     • "Ofrecer solución" → CUMPLE si resolvió el problema del cliente, aunque no haya dicho literalmente "le ofrezco la siguiente solución".
     • "Despedida cordial" → CUMPLE si cerró la llamada de forma amable ("gracias por llamar", "que tenga buen día", "con gusto"), aunque no siga un script palabra por palabra.
   - SOLO marca NO CUMPLE cuando hay una AUSENCIA REAL del comportamiento esperado, no cuando el asesor lo hizo con palabras diferentes.

═══ GUÍA DE INTERPRETACIÓN DE MÉTRICAS (QA CONTEXT) ═══
- Tiempo de Hold > 30s: Generalmente indica falta de conocimiento del asesor o problemas de sistema. Evalúa cómo el asesor retoma la llamada.
- Voz Elevada/Gritos: Si las métricas marcan picos de volumen en el cliente, evalúa la contención emocional del asesor. Si es en el asesor, es una falta grave de respeto.
- Silencios Largos: Pueden ser búsqueda de datos (aceptable si se informa al cliente) o "tiempo muerto" (mala práctica).
- Interrupciones: Un número alto indica falta de escucha activa o conflicto.

═══ PROTOCOLO ANTI-ALUCINACIONES (ESTRICTO) ═══
- Usa temperatura 0 (determinismo).
- Si no hay evidencia textual, marca "No hay evidencia" y justifica por qué no se puede validar.

═══ FORMATO DE RESPUESTA (SIEMPRE JSON válido) ═══
Responde ÚNICAMENTE con este JSON:

{
  "observacion_audio": "Análisis profundo enfocado en métricas y tono",
  "criterios": [ ... ],
  "puntaje_total": ...,
  "puntaje_maximo": ...,
  "porcentaje": ...,
  "resumen": "Resumen ejecutivo profesional y humano",
  "observaciones_autonomas": "Insights CX que el cliente no pidió",
  "recomendaciones_ia": ["accionable 1", "accionable 2"],
  "entregable": { ... } 
}`;

// ─── Helper: Normalize strings (remove accents, lowercase, trim) ──
function normalizeName(str) {
  if (!str) return '';
  return str.toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ─── Helper: Find the description key in a criterion object ──
// Template rows come from Excel with varying column names (Descripción, Descripcion, detalle, etc.)
function findDescriptionKey(objectKeys) {
  const keysNorm = objectKeys.map(k => normalizeName(k));
  const descPatterns = ['descripcion', 'descripción', 'detalle', 'regla', 'contexto'];
  return objectKeys.find((k, i) => descPatterns.some(p => keysNorm[i].includes(p))) || null;
}

// ─── Helper: Find the criterion name key in a criterion object ──
function findCriterionNameKey(objectKeys) {
  const keysNorm = objectKeys.map(k => normalizeName(k));
  const namePatterns = ['criterio especifico', 'item especifico', 'sub-criterio', 'subcriterio', 'parametro', 'nombre'];
  const catPatterns = ['criterio a evaluar', 'agrupador', 'categoria'];
  const itemKey = objectKeys.find((k, i) => namePatterns.some(p => keysNorm[i].includes(p)));
  if (itemKey) return itemKey;
  return objectKeys.find((k, i) => catPatterns.some(p => keysNorm[i].includes(p))) || null;
}

// ─── Helper: Parse column headers from template text ─────────
function parseTemplateColumns(templateText) {
  const lines = templateText.split('\n').filter(l => l.trim() && !l.trim().startsWith('==='));
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  return headerLine.split('|').map(h => h.trim()).filter(Boolean);
}

// ─── Helper: Normalize JSON template rows from Excel ──────────
// When the template is stored as JSON (from Excel upload), the rows have
// Excel column names like "Criterio a evaluar", "Peso", etc. instead of
// our internal _id/Nombre/Peso fields. This function detects and normalizes them.
function normalizeJsonTemplateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // If rows already have _id AND Nombre (from parseEvaluationCriteria), return as-is
  if (rows[0]._id != null && rows[0].Nombre) return rows;

  const sample = rows[0];
  const keys = Object.keys(sample);
  const keysLower = keys.map(k => normalizeName(k));

  // Detect which columns hold the criterion name components
  // "Criterio a evaluar" is usually the category, "Criterio Específico" is the item
  const categoryPatterns = ['criterio a evaluar', 'agrupador', 'categoria'];
  const itemPatterns = ['criterio especifico', 'item especifico', 'sub-criterio', 'subcriterio', 'parametro', 'nombre'];
  
  // 1. Try to find the MOST SPECIFIC item key first (to avoid "Criterio a evaluar" stealing it)
  let itemKey = keys.find((k, i) => {
    const l = keysLower[i];
    return l === 'criterio especifico' || l === 'item especifico' || l === 'criterio específico';
  });
  if (!itemKey) {
    itemKey = keys.find((k, i) => k.toLowerCase().includes('especifico') || k.toLowerCase().includes('específico'));
  }
  if (!itemKey) {
    itemKey = keys.find((k, i) => itemPatterns.some(p => keysLower[i] === p || keysLower[i].startsWith(p)));
  }
  
  // 2. Find category key (must be different from itemKey)
  let categoryKey = keys.find((k, i) => k !== itemKey && categoryPatterns.some(p => keysLower[i] === p || keysLower[i].startsWith(p)));

  // 3. Fallbacks if still missing
  if (!itemKey) {
    itemKey = keys.find((k, i) => k !== categoryKey && keysLower[i].includes('criterio'));
  }

  // Detect description column
  const descPatterns = ['descripcion', 'descripción', 'detalle', 'regla', 'contexto'];
  const descKey = keys.find((k, i) => descPatterns.some(p => keysLower[i].includes(p)));

  // Detect which column holds the weight/score
  const weightPatterns = ['peso', 'valor', 'punto', 'puntos', 'calificacion'];
  const weightKey = keys.find((k, i) => weightPatterns.some(p => keysLower[i].includes(p)));

  // Detect "tipo de campo" column for filtering metadata
  const tipoKey = keys.find((k, i) => keysLower[i].includes('tipo de campo') || keysLower[i] === 'tipo' || keysLower[i].includes('uso'));

  const skipValues = ['no aplica', 'n/a', 'informativo', 'por defecto', 'default', '', '---'];



  const result = [];
  const skipped = [];
  let lastCategory = '';
  let lastDescription = '';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowIdx = i + 1; // 1-based index to keep stable IDs with Excel rows

    // Carry-over logic for merged cells
    let catName = categoryKey ? String(row[categoryKey] || '').trim() : '';
    let itemName = itemKey ? String(row[itemKey] || '').trim() : '';
    let descContent = descKey ? String(row[descKey] || '').trim() : '';

    if (!catName && lastCategory) catName = lastCategory;
    if (catName) lastCategory = catName;

    if (!descContent && lastDescription) descContent = lastDescription;
    if (descContent) lastDescription = descContent;

    // Unify names to ensure uniqueness: "Category - Item"
    let name = '';
    if (catName && itemName && catName !== itemName) {
      name = `${catName} - ${itemName}`;
    } else {
      name = itemName || catName || '';
    }

    if (!name || skipValues.includes(name.toLowerCase())) continue;

    // Skip metadata rows where peso = "No aplica"
    if (weightKey) {
      const pesoVal = String(row[weightKey] || '').toLowerCase().trim();
      if (skipValues.includes(pesoVal)) {
        skipped.push(`"${name}" (peso="${row[weightKey]}")`);
        continue;
      }
    }

    // Skip metadata rows where tipo de campo = "Por defecto" or "Informativo"
    if (tipoKey) {
      const tipoVal = String(row[tipoKey] || '').toLowerCase().trim();
      if (skipValues.includes(tipoVal)) {
        skipped.push(`"${name}" (tipo="${row[tipoKey]}")`);
        continue;
      }
    }

    const pesoRaw = weightKey ? row[weightKey] : 0;
    const peso = parseFloat(String(pesoRaw).replace(/[^0-9.]/g, '')) || 0;

    // Capture all metadata
    const template_data = {};
    keys.forEach(k => {
      if (row[k] != null && String(row[k]).trim() !== '') {
        template_data[k] = row[k];
      } else if (k === categoryKey && catName) {
        template_data[k] = catName;
      } else if (k === descKey && descContent) {
        template_data[k] = descContent;
      }
    });

    result.push({
      _id: rowIdx,
      Nombre: name,
      Peso: peso,
      template_data
    });
  }

  return result;
}

// ─── Helper: Extract criteria objects from Markdown template ──────
function parseEvaluationCriteria(templateText) {
  if (!templateText) return [];
  const lines = templateText.split('\n').filter(l => l.trim() && !l.trim().startsWith('==='));
  if (lines.length < 2) return [];

  const headers = lines[0].split('|').map(h => h.trim());
  const headersLower = headers.map(h => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

  // Find column for name/criterion
  const namePatterns = ['especific', 'sub-criterio', 'subcriterio', 'parametro', 'criterio', 'item', 'nombre'];
  let nameIdx = headersLower.findIndex(h => namePatterns.some(p => h.includes(p)));
  if (nameIdx === -1 && headers.length >= 2) nameIdx = 1;

  // Find column for weight/points
  const weightPatterns = ['peso', 'valor', 'punto', 'puntos', 'calificacion'];
  let weightIdx = headersLower.findIndex(h => weightPatterns.some(p => h.includes(p)));

  const skipValues = ['no aplica', 'n/a', 'informativo', 'por defecto', 'default', '', '---'];

  // Also find "tipo de campo" column to detect metadata rows
  const tipoPatterns = ['tipo de campo', 'tipo'];
  const tipoIdx = headersLower.findIndex(h => tipoPatterns.some(p => h.includes(p)));

  const criteria = [];
  const skipped = [];
  let currentId = 1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('---')) continue;
    const cols = lines[i].split('|').map(c => c.trim());
    if (cols.length < (nameIdx + 1)) continue;

    const name = cols[nameIdx];
    if (!name || skipValues.includes(name.toLowerCase())) continue;

    // Skip metadata rows: if peso column says "No aplica" or similar, it's not an evaluable criterion
    if (weightIdx !== -1 && cols[weightIdx]) {
      const pesoRaw = cols[weightIdx].toLowerCase().trim();
      if (skipValues.includes(pesoRaw)) {
        skipped.push(`"${name}" (peso="${cols[weightIdx]}")`);
        continue;
      }
    }

    // Skip rows where "tipo de campo" is "por defecto" or "informativo" (metadata fields like Hora, Fecha)
    if (tipoIdx !== -1 && cols[tipoIdx]) {
      const tipoRaw = cols[tipoIdx].toLowerCase().trim();
      if (skipValues.includes(tipoRaw)) {
        skipped.push(`"${name}" (tipo="${cols[tipoIdx]}")`);
        continue;
      }
    }

    let peso = 0;
    if (weightIdx !== -1 && cols[weightIdx]) {
      peso = parseFloat(cols[weightIdx].replace(/[^0-9.]/g, '')) || 0;
    }

    // Also capture all column data for template_data display
    const template_data = {};
    headers.forEach((h, idx) => {
      if (idx < cols.length && idx !== nameIdx && idx !== weightIdx) {
        template_data[h] = cols[idx];
      }
    });

    criteria.push({
      _id: currentId++,
      Nombre: name,
      Peso: peso,
      template_data
    });
  }

  return criteria;
}

// ─── LEGACY: Old base prompt for backward compatibility ───────
const BASE_ANALYSIS_PROMPT = `Eres un agente de calidad especializado en evaluar interacciones de servicio al cliente.
Tu tarea es analizar la interaccion proporcionada y generar una evaluacion detallada y objetiva.

═══ FORMATO DE RESPUESTA OBLIGATORIO ═══
Responde SIEMPRE en JSON valido con EXACTAMENTE esta estructura (no agregues ni quites campos):
{
  "calificacion": <numero entero del 1 al 10>,
  "cumple_protocolo": <true o false>,
  "puntos_positivos": ["punto 1", "punto 2", ...],
  "puntos_negativos": ["punto 1", "punto 2", ...],
  "recomendaciones": ["recomendacion 1", "recomendacion 2", ...],
  "resumen": "resumen breve de la evaluacion general"
}

REGLAS:
- calificacion: 1 = pesimo, 5 = aceptable, 10 = excelente
- cumple_protocolo: true si el asesor siguio los procedimientos correctos
- puntos_positivos y puntos_negativos: minimo 1 elemento cada uno
- recomendaciones: minimo 1 sugerencia concreta de mejora
- resumen: maximo 2 oraciones`;

// ─── DEFAULT DELIVERABLE TEMPLATE ─────────────────────────────
const DEFAULT_DELIVERABLE_TEMPLATE = `Responde SIEMPRE en JSON válido con esta estructura:
{
  "observacion_audio": "Análisis profundo del contexto emocional y técnico (holds, volumen, etc.)",
  "criterios": [
    {
      "id": ID del criterio (ej: 1, 2, 3),
      "analisis_paso_a_paso": "OBLIGATORIO: Cita la frase exacta del asesor/cliente. Ej: 'Regla: Saludo. Texto: El asesor dice \"Buenos días\". CUMPLE.'",
      "cumple": true/false,
      "puntaje": 0 o el peso correspondiente,
      "observacion": "Conclusión concisa para el reporte final"
    }
  ],
  "puntaje_total": suma de puntos obtenidos,
  "puntaje_maximo": suma de pesos totales,
  "porcentaje": calificacion porcentual (0-100),
  "resumen": "Resumen ejecutivo del desempeño del asesor (2-3 oraciones)"
}

IMPORTANTE: El campo 'analisis_paso_a_paso' es donde demuestras tu capacidad de auditoría senior. No seas genérico.`;

// ─── AI Client Helper ──────────────────────────────────────────
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' || error.message?.includes('ECONNRESET') ||
        error.message?.includes('429') || error.status === 429 ||
        error.message?.includes('fetch') || (error.status >= 500 && error.status < 600);
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[B2B Agent] Retry ${attempt}/${maxRetries} after ${delay}ms — ${error.code || error.message?.substring(0, 60)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function createAIClient(aiConfig, type = 'auditor') {
  const apiKey = decrypt(aiConfig.ai_api_key);
  const provider = aiConfig.ai_provider;
  
  // Model selection: Use GPT-4o for auditors, gpt-4o-mini for filters/others
  let model = aiConfig.ai_model || 'gpt-4o-mini';
  if (provider === 'openai' && type === 'auditor') {
    model = 'gpt-4o'; // Force higher model for reasoning
  }

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey });
    return {
      provider,
      model,
      callAI: async (systemPrompt, userMessage) => {
        return withRetry(async () => {
          const response = await client.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage }
            ],
            temperature: 0,
            top_p: 1,
            max_tokens: 8192, // Increased for deep reasoning and large batches
            response_format: { type: 'json_object' }
          });
          const result = JSON.parse(response.choices[0].message.content);
          const usage = response.usage ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
            model,
          } : null;
          return { result, usage };
        });
      }
    };
  }

  if (provider === 'gemini') {
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    return {
      provider,
      model,
      callAI: async (systemPrompt, userMessage) => {
        return withRetry(async () => {
          const response = await axios.post(
            `${baseUrl}/models/${model}:generateContent?key=${apiKey}`,
            {
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ parts: [{ text: userMessage }] }],
              generationConfig: {
                temperature: 0,
                topP: 1,
                maxOutputTokens: 4000,
                responseMimeType: 'application/json'
              }
            },
            { timeout: 60000 }
          );
          const text = response.data.candidates[0].content.parts[0].text;
          return JSON.parse(text);
        });
      }
    };
  }

  throw new Error(`AI provider not supported: ${provider}`);
}

// ─── Step 2: Filter/classify interaction ───────────────────────
async function filterInteraction(text, customPrompt, aiConfig, agents = [], accumulatedFeedback = '') {
  const { callAI } = createAIClient(aiConfig, 'filter');
  
  // Format categories with descriptions if available
  const categoriesList = agents.length > 0 
    ? agents.map(agent => {
        const name = typeof agent === 'string' ? agent : agent.name;
        const desc = typeof agent === 'object' && agent.description ? ` (${agent.description})` : '';
        const hint = typeof agent === 'object' && agent.filter_hint ? `\n  Diferenciacion: ${agent.filter_hint}` : '';
        return `- ${name}${desc}${hint}`;
      }).join('\n')
    : '- otro: no hay agentes configurados';
    
  const agentNames = agents.map(a => typeof a === 'string' ? a : a.name);
  const categoriesEnum = [...agentNames, 'otro'].join('|');

  const dynamicPrompt = `Eres un agente experto en clasificación de interacciones de servicio al cliente.
Tu objetivo es leer la interacción y determinar cuál es el agente especializado más adecuado para realizar la auditoría de calidad.

CATEGORÍAS DISPONIBLES (Nombre y Propósito):
${categoriesList}
- otro: No encaja en ninguna de las anteriores o es ruido/saludo breve.

${accumulatedFeedback ? `APRENDIZAJE DE ERRORES PASADOS (Prioridad Alta):\n${accumulatedFeedback}\n\n` : ''}${customPrompt ? `INSTRUCCIONES ADICIONALES DEL CLIENTE:\n${customPrompt}\n\n` : ''}REGLAS DE DECISIÓN:
1. Si el texto coincide claramente con el propósito de un agente, elígelo.
2. Si hay duda entre dos, elige el que mejor describa el contenido técnico de la llamada.
3. Si el texto es demasiado corto para clasificar, usa "otro".

Responde estrictamente en JSON:
{ 
  "categoria": "${categoriesEnum}", 
  "confidence": 0.0-1.0, 
  "razon": "Breve explicación de por qué elegiste esta categoría" 
}`;

  const { result: filterResultRaw, usage: filterUsage } = await callAI(dynamicPrompt, `Interacción a clasificar:\n\n${text}`);
  let categoria = filterResultRaw.categoria || 'otro';

  // Robust matching: Try exact, then normalized
  if (![...agentNames, 'otro'].includes(categoria)) {
    const normalizedCat = normalizeName(categoria);
    const match = agentNames.find(n => normalizeName(n) === normalizedCat);
    categoria = match || 'otro';
  }

  return { categoria, confidence: filterResultRaw.confidence || 0.5, razon: filterResultRaw.razon || '', _usage: filterUsage };
}

// ─── Step 3: Prompt Building v2 (5 layers) ──────────────────────
function buildFullPromptV2(agent) {
  const hasV2Fields = agent.evaluation_template || agent.deliverable_template;
  if (!hasV2Fields) return buildFullPrompt(agent.system_prompt);

  const parts = [FIXED_QUALITY_PROMPT];

  // ─── ASESOR TARGETING: Extract which asesor to evaluate from description ───
  if (agent.description) {
    parts.push(`\n═══ CONTEXTO DE LA OPERACIÓN ═══\n${agent.description}`);
    // Detect "asesor 1", "asesor 2", etc. in description and inject targeting rule
    const asesorMatch = agent.description.match(/asesor\s*(\d+)/i);
    if (asesorMatch) {
      parts.push(`\n═══ ASESOR OBJETIVO (REGLA PRIORITARIA) ═══
IMPORTANTE: En esta transcripción pueden aparecer múltiples asesores (Asesor 1, Asesor 2, etc.).
Tu tarea es evaluar EXCLUSIVAMENTE al ASESOR ${asesorMatch[1]}.
IGNORA completamente las acciones, frases y comportamientos de cualquier otro asesor.
Si un criterio se refiere a algo que hizo otro asesor, NO lo evalúes — solo evalúa al Asesor ${asesorMatch[1]}.
Cualquier calificación debe basarse ÚNICAMENTE en lo que dijo e hizo el Asesor ${asesorMatch[1]}.`);
    }
  }
  if (agent.system_prompt) parts.push(`\n═══ INSTRUCCIONES ESPECÍFICAS DE INTELIGENCIA ═══\n${agent.system_prompt}`);
  
  if (agent.evaluation_template) {
    const template = agent.evaluation_template.trim();
    if (template.startsWith('[')) {
      parts.push(`\n═══ PLANTILLA DE CALIFICACIÓN (JSON) ═══\nLee esta plantilla JSON. Cada objeto es un criterio con "id" único y un "Peso" (importancia relativa).

INSTRUCCIONES CRÍTICAS DE EVALUACIÓN:
- Razona PASO A PASO antes de emitir "cumple" para cada criterio.
- Evalúa el ESPÍRITU del criterio, NO las palabras textuales. Si el asesor logró el objetivo con palabras diferentes → CUMPLE.
- Un buen asesor puede cumplir un protocolo de muchas formas distintas. Tu trabajo es detectar si el OBJETIVO se cumplió, no si usó un script exacto.
- Si hay duda razonable y la evidencia sugiere que sí cumplió → dale el beneficio de la duda y marca CUMPLE con observación.
- Solo marca NO CUMPLE cuando hay ausencia clara y real del comportamiento esperado.
- Para cada criterio, DEBES incluir un campo "observacion" con un comentario DETALLADO y NARRATIVO que explique:
  • POR QUÉ cumple o no cumple, citando evidencia específica de la transcripción.
  • Ejemplo CUMPLE: "Cumple porque en el minuto 2:30 el asesor saludó cordialmente diciendo 'Buenos días, le habla María de Stream' e identificó el motivo de la llamada."
  • Ejemplo NO CUMPLE: "No cumple porque en toda la llamada el asesor nunca mencionó el ticket de seguimiento ni proporcionó número de referencia al cliente."

${template}`);
    } else {
      parts.push(`\n═══ PLANTILLA DE CALIFICACIÓN (TEXTO) ═══\n${template}`);
    }
  }

  if (agent.deliverable_template) {
    parts.push(`\n═══ PLANTILLA DE ENTREGABLE ═══\nCompleta el campo "entregable" siguiendo esta plantilla:\n\n${agent.deliverable_template}`);
  }

  if (agent.feedback_accumulated) {
    parts.push(`\n═══ RETROALIMENTACIÓN ACUMULADA (APRENDIZAJE) ═══\nMejoras de sesiones anteriores:\n${agent.feedback_accumulated}\n\nNOTA: Esta retroalimentación es aprendizaje de auditorías reales. Si hay conflicto con la plantilla de calificación, la retroalimentación tiene PRIORIDAD porque refleja correcciones de un auditor humano.`);
  }

  parts.push(`\n═══ FORMATO JSON DE RESPUESTA ═══\n${DEFAULT_DELIVERABLE_TEMPLATE}\nResponde ÚNICAMENTE con JSON válido.`);
  return parts.join('\n');
}

function buildFullPrompt(customCriteria) {
  if (!customCriteria || !customCriteria.trim()) return BASE_ANALYSIS_PROMPT + '\nEvalua de forma general.';
  return BASE_ANALYSIS_PROMPT + '\n' + customCriteria;
}

// ─── Step 4: Analysis Flow (Chunking + Director) ───────────────
async function analyzeInteraction(text, agentOrCriteria, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'auditor');
  let templateRows = null;
  let isJsonTemplate = false;

  if (agentOrCriteria?.evaluation_template) {
    const templateStr = agentOrCriteria.evaluation_template.trim();
    if (templateStr.startsWith('[')) {
      try { templateRows = normalizeJsonTemplateRows(JSON.parse(templateStr)); isJsonTemplate = true; } catch (e) { }
    } else {
      // It's a text/markdown template - parse it to assign IDs and Weights
      templateRows = parseEvaluationCriteria(templateStr);
      if (templateRows.length > 0) isJsonTemplate = true;
    }
  }

  // CRITICAL: Always send clean JSON with "id" (not "_id") to the AI so it returns matching IDs
  // We also include "Descripcion" from template_data if available for better context
  const cleanRowsForAI = (rows) => rows.map(r => {
    const context = r.template_data?.Descripción || r.template_data?.Descripcion || r.template_data?.desc || r.template_data?.['Descripción'] || '';
    return { 
      id: r._id, 
      Nombre: `[ID ${r._id}] ${r.Nombre}`, // Force ID in name to prevent AI confusion
      Peso: r.Peso,
      Regla: context // renamed to Regla to be more explicit for the auditor
    };
  });

  const agentForAI = templateRows && templateRows.length > 0
    ? { ...agentOrCriteria, evaluation_template: JSON.stringify(cleanRowsForAI(templateRows)) }
    : agentOrCriteria;

  // Chunk size: 2 criteria per assistant for maximum precision and zero hallucination
  const CHUNK_SIZE = 2;

  if (!isJsonTemplate || !templateRows || templateRows.length <= CHUNK_SIZE) {
    const fullPrompt = buildFullPromptV2(agentForAI);
    const { result, usage } = await callAI(fullPrompt, `Interacción a analizar:\n\n${text}`);
    return { ...processEvaluationResult(result, agentOrCriteria, templateRows), _usage: usage };
  }

  const totalChunks = Math.ceil(templateRows.length / CHUNK_SIZE);

  // Run all chunks in parallel — each evaluates exactly 2 criteria with deep focus
  const chunkResolvedResults = await Promise.all(
    Array.from({ length: totalChunks }, (_, i) => {
      const chunkRows = templateRows.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkPrompt = buildFullPromptV2({ ...agentOrCriteria, evaluation_template: JSON.stringify(cleanRowsForAI(chunkRows)) });
      const chunkUserMsg = `═══ TAREA DE ESPECIALISTA (Lote ${i+1}/${totalChunks}) ═══
Evalúa EXCLUSIVAMENTE los IDs: ${chunkRows.map(r => r._id).join(', ')}.
Recuerda: evalúa el ESPÍRITU del criterio, no las palabras exactas. Si el asesor cumplió el objetivo con su propio estilo → CUMPLE.

Para cada criterio, tu campo "observacion" DEBE ser un comentario narrativo DETALLADO explicando:
- POR QUÉ cumple o no cumple, con evidencia textual de la transcripción.
- Cita frases específicas del asesor o momentos clave.
- Ejemplo: "Cumple porque el asesor dijo 'le informo que su ticket es el #134813' en el minuto 5."
- Ejemplo: "No cumple porque en los primeros 30 segundos el asesor no se identificó ni mencionó la empresa."

Además, genera un campo "resumen_lote" con un breve párrafo narrativo describiendo qué encontraste en estos ${chunkRows.length} criterios.

Interacción:
${text}`;
      return callAI(chunkPrompt, chunkUserMsg);
    })
  );
  const chunkResults = chunkResolvedResults.map(r => r.result);
  const chunkUsages = chunkResolvedResults.map(r => r.usage).filter(Boolean);

  const directorResult = await consolidateWithDirector(chunkResults, text, agentOrCriteria, templateRows, aiConfig);
  // Merge all chunk usages + director usage
  const allUsages = [...chunkUsages, directorResult._usage].filter(Boolean);
  const mergedUsage = allUsages.length > 0 ? {
    inputTokens: allUsages.reduce((s, u) => s + (u.inputTokens || 0), 0),
    outputTokens: allUsages.reduce((s, u) => s + (u.outputTokens || 0), 0),
    totalTokens: allUsages.reduce((s, u) => s + (u.totalTokens || 0), 0),
    model: allUsages[0].model,
  } : null;
  return { ...directorResult, _usage: mergedUsage };
}

async function consolidateWithDirector(chunkResults, transcript, agent, templateRows, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'auditor');
  const auditorCriteria = chunkResults.flatMap(r => r.criterios || []);
  const auditorSummaries = chunkResults.map((r, i) => r.resumen_lote || r.resumen || '').filter(Boolean);

  // Build deliverable template section for the director if agent has one
  let entregableInstruction = '';
  if (agent.deliverable_template) {
    let deliverableColumns = [];
    const dtTrimmed = agent.deliverable_template.trim();
    if (dtTrimmed.startsWith('[')) {
      try {
        const rows = JSON.parse(dtTrimmed);
        if (Array.isArray(rows) && rows.length > 0) {
          deliverableColumns = Object.keys(rows[0]).filter(k => k && k !== '_id' && k !== 'id');
        }
      } catch (e) { /* ignore */ }
    }
    if (deliverableColumns.length === 0) {
      const lines = agent.deliverable_template.split('\n').filter(l => l.trim() && !l.trim().startsWith('===') && !l.trim().match(/^-+(\s*\|\s*-+)*$/));
      if (lines.length > 0) {
        deliverableColumns = lines[0].split('|').map(h => h.trim()).filter(Boolean);
      }
    }
    if (deliverableColumns.length > 0) {
      entregableInstruction = `\n7. ENTREGABLE: Genera un objeto "entregable" con estas columnas: ${JSON.stringify(deliverableColumns)}. Para cada columna, pon "SI" o "NO" según el criterio correspondiente. Columnas de puntaje/score → porcentaje. Columnas de comentario/observación → resumen.`;
    }
  }

  const entregableJsonField = entregableInstruction ? ', "entregable": { "columna": "SI/NO", ... }' : '';

  const directorPrompt = `Eres el DIRECTOR DE CALIDAD. Consolida los resultados de los auditores especialistas.
PLANTILLA: ${JSON.stringify(templateRows.map(r => ({ id: r._id, Nombre: r.Nombre })), null, 2)}
RESULTADOS DE LOS AUDITORES (cada uno evaluó un lote de 2 criterios con análisis profundo):
${JSON.stringify(auditorCriteria, null, 2)}

RESÚMENES DE CADA AUDITOR (mini-reportes por lote):
${auditorSummaries.map((s, i) => `[Lote ${i+1}]: ${s}`).join('\n')}

INSTRUCCIONES:
1. Genera un JSON consolidado. Para cada criterio de la PLANTILLA, busca su resultado correspondiente usando el ID como clave principal.
2. IMPORTANTE: Los Nombres de los criterios ya son únicos y corresponden a filas de Excel específicas. NO los agrupes ni modifiques sus IDs.
3. REVISIÓN DE JUSTICIA: Si un auditor marcó NO CUMPLE pero su observación describe que el asesor SÍ realizó la acción (con palabras diferentes al protocolo), CORRIGE a CUMPLE. El asesor merece crédito si logró el objetivo aunque con estilo propio.
4. PRESERVA las "observacion" detalladas de cada auditor. Estas son los comentarios RICOS que explican por qué cada criterio cumple o no cumple con evidencia. NO las resumas ni acortes — son el valor principal del reporte.
5. Calcula el % final sumando los pesos de los criterios marcados como CUMPLE.
6. "resumen": Genera un RESUMEN NARRATIVO PROFESIONAL consolidando los mini-reportes de todos los auditores. Debe leerse como un párrafo continuo y descriptivo del tipo:
   "Titular indica que contrató con otro proveedor... el asesor ofrece alternativas de retención sin éxito, realiza proceso de validación, informa ticket #134813... Se sugiere consultar el nuevo proveedor."
   Este resumen debe cubrir: qué pidió el cliente, qué hizo el asesor, puntos fuertes, puntos débiles, y una sugerencia si aplica.
Responde ÚNICAMENTE con JSON: { "porcentaje": 0-100, "calificacion": 0-10, "resumen": "párrafo narrativo profesional largo", "criterios": [...]${entregableJsonField}, "observacion_audio": "string" }${entregableInstruction}`;

  const { result: finalResultRaw, usage: directorUsage } = await callAI(directorPrompt, "Genera el reporte final consolidado.");
  return { ...processEvaluationResult(finalResultRaw, agent, templateRows), _usage: directorUsage };
}

function processEvaluationResult(result, agentOrCriteria, templateRows, lockedCriteriaValues) {
  if (!Array.isArray(result.criterios)) return result;

  if (templateRows?.length > 0) {
    // Build a set of valid IDs from the template
    const validIds = new Set(templateRows.map(r => r._id));
    const aiById = new Map();
    
    result.criterios.forEach(c => {
      // Robust ID parsing: handle "id", "Id", "ID", "_id", or even "1."
      let rawId = c.id ?? c.Id ?? c.ID ?? c._id ?? c.index;
      if (rawId == null) {
        // Last resort: find any key that looks like an ID
        const possibleIdKey = Object.keys(c).find(k => k.toLowerCase() === 'id');
        if (possibleIdKey) rawId = c[possibleIdKey];
      }

      let idNum = parseInt(String(rawId).replace(/[^0-9]/g, ''));
      if (!isNaN(idNum)) {
        aiById.set(idNum, c);
      }
    });

    // Build name-based fallback map for when AI returns wrong IDs but correct names
    const aiByName = new Map();
    result.criterios.forEach(c => {
      const name = normalizeName(c.nombre || c.name || c.Nombre || '');
      if (name) aiByName.set(name, c);
    });

    // Reconstruct criterios strictly from template order
    let unmatchedCount = 0;
    result.criterios = templateRows.map(row => {
      const rawPeso = row.Peso || row.peso || row.Puntos || row.Valor || 0;
      const peso = typeof rawPeso === 'number' ? rawPeso : parseFloat(String(rawPeso).replace(/[^0-9.]/g, '') || '0') || 0;
      const nombre = row.Nombre || row.Criterio || `ID ${row._id}`;

      // If this criterion was locked by human reviewer, use the preserved value
      if (lockedCriteriaValues) {
        const locked = lockedCriteriaValues.find(lc => lc.id === row._id);
        if (locked) {
          return { 
            id: row._id, 
            nombre: `${row.Nombre}`, 
            peso, 
            cumple: locked.cumple, 
            puntaje: locked.cumple ? peso : 0, 
            observacion: locked.observacion || '', 
            _locked: true,
            template_data: row.template_data // PRESERVE METADATA
          };
        }
      }

      // Try match by ID first
      let aiCrit = aiById.get(row._id);

      // Fallback: match by normalized name if ID didn't match
      if (!aiCrit) {
        const normalizedName = normalizeName(nombre);
        aiCrit = aiByName.get(normalizedName);
        if (aiCrit) {
          // matched by name fallback
        }
      }

      if (aiCrit) {
        return { 
          ...aiCrit, 
          id: row._id, 
          nombre, 
          peso,
          template_data: row.template_data // PRESERVE METADATA
        };
      }

      // AI forgot to evaluate this criterion — mark as not evaluated
      unmatchedCount++;
      console.warn(`[B2B AgentService] Criterion ${row._id} (${nombre}) missing from AI response — defaulting to NO CUMPLE`);
      return { 
        id: row._id, 
        nombre, 
        peso, 
        cumple: false, 
        puntaje: 0, 
        observacion: 'No evaluado por la IA',
        template_data: row.template_data // PRESERVE METADATA
      };
    });

    if (unmatchedCount > 0) {
      console.warn(`[B2B AgentService] ${unmatchedCount}/${templateRows.length} criteria unmatched. AI returned IDs: ${[...aiById.keys()].join(',')} — Template IDs: ${[...validIds].join(',')}`);
    }
  }

  let calcTotal = 0, calcMax = 0;
  result.criterios.forEach(c => {
    const peso = c.peso || 0;
    calcMax += peso;
    const val = String(c.cumple ?? '').toUpperCase().trim();
    if (c.cumple === true || val === 'TRUE' || val === 'SI' || val === 'SÍ') {
      calcTotal += peso; c.puntaje = peso; c.cumple = true;
    } else {
      c.puntaje = 0; c.cumple = false;
    }
  });

  result.porcentaje = calcMax > 0 ? Math.round((calcTotal / calcMax) * 100) : (result.porcentaje || 0);
  return {
    ...result,
    puntaje_total: calcTotal,
    puntaje_maximo: calcMax,
    calificacion: Math.round(result.porcentaje / 10)
  };
}

// ─── Step 5: Reprocess and Smart Learning ──────────────────────
async function reprocessInteraction(text, agentOrCriteria, previousResult, humanFeedback, aiConfig) {
  let templateRows = null;
  let isJsonTemplate = false;

  if (agentOrCriteria?.evaluation_template) {
    const templateStr = agentOrCriteria.evaluation_template.trim();
    if (templateStr.startsWith('[')) {
      try { templateRows = normalizeJsonTemplateRows(JSON.parse(templateStr)); isJsonTemplate = true; } catch (e) { }
    } else {
      templateRows = parseEvaluationCriteria(templateStr);
      if (templateRows.length > 0) isJsonTemplate = true;
    }
  }

  // Always convert to clean JSON so AI gets proper "id" values (not "_id")
  const cleanRowsForAI = (rows) => rows.map(r => ({ id: r._id, Nombre: r.Nombre, Peso: r.Peso }));
  const agentForAI = templateRows && templateRows.length > 0
    ? { ...agentOrCriteria, evaluation_template: JSON.stringify(cleanRowsForAI(templateRows)) }
    : agentOrCriteria;

  const CHUNK_SIZE = 2;

  // If no chunking needed
  if (!isJsonTemplate || !templateRows || templateRows.length <= CHUNK_SIZE) {
    return _callReprocessAI(text, agentForAI, previousResult, humanFeedback, aiConfig);
  }

  // Chunked reprocess — run all chunks in parallel
  const totalChunks = Math.ceil(templateRows.length / CHUNK_SIZE);

  const chunkResults = await Promise.all(
    Array.from({ length: totalChunks }, (_, i) => {
      const chunkRows = templateRows.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkPrevResult = {
        ...previousResult,
        criterios: Array.isArray(previousResult?.criterios)
          ? previousResult.criterios.filter(c => chunkRows.some(r => r._id === Number(c.id)))
          : []
      };
      return _callReprocessAI(
        text,
        { ...agentOrCriteria, evaluation_template: JSON.stringify(chunkRows) },
        chunkPrevResult,
        humanFeedback,
        aiConfig,
        ` (Lote ${i+1}/${totalChunks})`
      );
    })
  );

  return consolidateWithDirector(chunkResults, text, agentOrCriteria, templateRows, aiConfig);
}

async function _callReprocessAI(text, agentOrCriteria, previousResult, humanFeedback, aiConfig, chunkLabel = '', lockedIds = [], correctionItems = []) {
  const { callAI } = createAIClient(aiConfig, 'auditor');
  const fullPrompt = buildFullPromptV2(agentOrCriteria);

  const prevCriteriosText = Array.isArray(previousResult?.criterios)
    ? previousResult.criterios.map(c => `- ${c.nombre || c.id}: ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'} (${c.puntaje})`).join('\n')
    : 'No disponibles';

  let contextMessage;

  if (lockedIds.length > 0 || correctionItems.length > 0) {
    // ── Modo quirúrgico: solo recalifica criterios específicos ──
    const lockedCrits = Array.isArray(previousResult?.criterios)
      ? previousResult.criterios.filter(c => lockedIds.includes(Number(c.id)))
      : [];
    const lockedBlock = lockedCrits.map(c =>
      `- Criterio ${c.id} (${c.nombre || ''}): Ya validado como ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'}`
    ).join('\n');

    const corrBlock = correctionItems.map(ci => {
      const prev = Array.isArray(previousResult?.criterios) ? previousResult.criterios.find(c => Number(c.id) === Number(ci.id)) : null;
      return `- Criterio ${ci.id} (${prev?.nombre || ''}): RE-EVALÚA — Observación del revisor humano: "${ci.feedback}"`;
    }).join('\n');

    contextMessage = `MODO: REPROCESO QUIRÚRGICO${chunkLabel}

CRITERIOS CONTEXTUALES (ya validados, tomalos solo como contexto):
${lockedBlock || '(ninguno)'}

CRITERIOS A RE-EVALUAR:
${corrBlock || '(ninguno)'}

INSTRUCCIÓN MUY IMPORTANTE: NO incluyas los criterios contextuales en tu respuesta JSON.
Tu matriz de "criterios" en el JSON final SOLO DEBE CONTENER los criterios a re-evaluar. 
Analiza la transcripción con la observación del revisor y emite la nueva calificación únicamente para ellos.

Interacción:
${text}`;
  } else {
    // ── Modo legacy: reproceso completo con feedback general ──
    contextMessage = `REPROCESO POR RECHAZO HUMANO${chunkLabel}:
Feedback: "${humanFeedback}"
Análisis anterior:
${prevCriteriosText}

INSTRUCCIONES: Re-evalúa incorporando las correcciones del feedback.

Interacción:
${text}`;
  }

  const { result: rawResult, usage } = await callAI(fullPrompt, contextMessage);
  const processed = processEvaluationResult(rawResult, agentOrCriteria, null);
  return { ...processed, _usage: usage };
}

/**
 * Selective reprocess: only re-evaluate specific criteria flagged by human reviewer.
 * Locked criteria values are preserved exactly from previousResult.
 * @param {string} text - Full transcript
 * @param {object} agent - Agent with evaluation_template
 * @param {object} previousResult - Previous agent_result JSONB
 * @param {number[]} lockedCriteriaIds - Criterion IDs confirmed correct by reviewer
 * @param {{ id: number, feedback: string }[]} correctionCriteria - Criteria to fix + why
 * @param {object} aiConfig
 */
async function selectiveReprocessInteraction(text, agent, previousResult, lockedCriteriaIds, correctionCriteria, aiConfig) {
  let templateRows = null;
  if (agent?.evaluation_template) {
    const templateStr = agent.evaluation_template.trim();
    if (templateStr.startsWith('[')) {
      try { templateRows = normalizeJsonTemplateRows(JSON.parse(templateStr)); } catch (e) { }
    } else {
      templateRows = parseEvaluationCriteria(templateStr);
    }
  }

  // Automatic Locking: All criteria NOT in correctionCriteria should be locked by default
  // This preserves the full score and state from the previous result
  if (templateRows && Array.isArray(previousResult?.criterios)) {
    const correctionIds = new Set(correctionCriteria.map(c => Number(c.id)));
    const autoLockedIds = previousResult.criterios
      .map(c => Number(c.id))
      .filter(id => !correctionIds.has(id));
    
    // Merge with explicitly locked IDs if any
    lockedCriteriaIds = Array.from(new Set([...(lockedCriteriaIds || []), ...autoLockedIds]));
  }

  // Only send correction criteria to the AI (reduce token cost)
  const cleanRowsForAI = (rows) => rows.map(r => ({ id: r._id, Nombre: r.Nombre, Peso: r.Peso }));
  const correctionIds = correctionCriteria.map(c => Number(c.id));
  const correctionTemplateRows = templateRows ? templateRows.filter(r => correctionIds.includes(r._id)) : null;
  const agentForCorrection = correctionTemplateRows
    ? { ...agent, evaluation_template: JSON.stringify(cleanRowsForAI(correctionTemplateRows)) }
    : agent;

  // Run AI only on correction criteria
  const aiResult = await _callReprocessAI(
    text,
    agentForCorrection,
    previousResult,
    null,
    aiConfig,
    '',
    lockedCriteriaIds,
    correctionCriteria
  );

  // Merge: take locked values from previousResult, AI values for correction criteria
  if (templateRows && Array.isArray(previousResult?.criterios)) {
    const lockedValues = previousResult.criterios
      .filter(c => lockedCriteriaIds.includes(Number(c.id)))
      .map(c => ({ id: Number(c.id), cumple: c.cumple, puntaje: c.puntaje, observacion: c.observacion }));

    // processEvaluationResult will inject locked values and recompute totals
    return processEvaluationResult(aiResult, agent, templateRows, lockedValues);
  }

  return aiResult;
}

/**
 * Detects which criteria IDs are affected by a general human feedback comment using AI context analysis.
 */
async function detectAffectedCriteriaByFeedback(agent, previousResult, humanFeedback, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'filter'); // use faster model

  if (!humanFeedback || !previousResult?.criterios?.length) return [];

  const criteriaContext = previousResult.criterios.map(c => 
    `ID: ${c.id} | Criterio: ${c.nombre} | Estado: ${c.cumple ? 'CUMPLE' : 'NO CUMPLE'}`
  ).join('\n');

  const prompt = `Un auditor humano ha rechazado una evaluación con este comentario general:
"${humanFeedback}"

Aquí está la lista de todos los criterios evaluados y su estado actual:
${criteriaContext}

TAREA: Analiza el comentario y determina CUÁLES IDs numéricos de la lista anterior se ven afectados por su queja y necesitan ser re-evaluados por la IA.
- Si el humano dice "no saludó adecuadamente", devuelve el ID del criterio de Saludo.
- Si se queja de un "mal tono de voz", devuelve el ID de Tono de Voz.
- Si el comentario es tan genérico que afecta a toda la llamada o no se puede aislar en criterios específicos, devuelve arreglo vacío [].
- Devuelve SOLO una matriz JSON con los IDs numéricos, sin texto adicional.

Responde únicamente: { "affected_ids": [1, 5] }`;

  try {
    const { result } = await callAI(prompt, "Detecta los IDs afectados");
    return Array.isArray(result.affected_ids) ? result.affected_ids.map(Number) : [];
  } catch (err) {
    console.error('[B2B Agent] Error detecting affected criteria:', err.message);
    return []; 
  }
}

async function distillFeedback(rawFeedback, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'auditor');
  const prompt = `Extrae la REGLA GENERAL de este feedback de auditoría, eliminando detalles específicos de audios (tiempos, nombres). Si no hay valor instructivo responde NO_VALOR.
Feedback: "${rawFeedback}"`;

  try {
    const { result: distilled } = await callAI(prompt, "Genera regla general.");
    const text = distilled.regla || distilled.rule || distilled.resumen || distilled.feedback || (typeof distilled === 'string' ? distilled : JSON.stringify(distilled));
    return (text.trim() === 'NO_VALOR' || text.length < 5) ? null : text.trim();
  } catch (e) { return null; }
}

/**
 * AI-powered template refinement: takes a criterion's current description + human correction
 * and generates an ADDENDUM to enrich the description. NEVER removes existing text.
 * Returns { addendum: string, wasUseful: boolean } or null on error.
 */
async function refineTemplateDescription(currentDescription, criterionName, humanFeedback, aiConfig) {
  if (!humanFeedback || !humanFeedback.trim()) return null;

  // Fast deduplication: skip if >70% of feedback words already in description
  const descWords = new Set(normalizeName(currentDescription).split(/\s+/).filter(w => w.length > 3));
  const feedbackWords = normalizeName(humanFeedback).split(/\s+/).filter(w => w.length > 3);
  if (feedbackWords.length > 0) {
    const overlap = feedbackWords.filter(w => descWords.has(w)).length;
    if (overlap / feedbackWords.length > 0.7) {
      return { addendum: '', wasUseful: false };
    }
  }

  const { callAI } = createAIClient(aiConfig, 'filter');

  const prompt = `Eres un especialista en diseño de rúbricas de evaluación de calidad para call centers.

CRITERIO: "${criterionName}"
DESCRIPCIÓN ACTUAL:
"""
${currentDescription}
"""

CORRECCIÓN DEL AUDITOR HUMANO:
"""
${humanFeedback}
"""

TAREA: Analiza la corrección y genera texto NUEVO para AGREGAR a la descripción del criterio.

REGLAS ESTRICTAS:
1. NO repitas nada que ya esté en la descripción actual — léela completa antes de responder.
2. NO elimines ni reformules texto existente — solo genera un ADDENDUM nuevo.
3. Extrae: nuevos escenarios, excepciones, aclaraciones de borde, o ejemplos concretos que enriquezcan la regla.
4. Si la corrección es muy específica a un audio particular (nombres propios, tiempos exactos, números de cuenta) y no aporta una regla general reutilizable → responde { "addendum": "", "wasUseful": false }.
5. Si lo que dice la corrección ya está cubierto por la descripción existente → responde { "addendum": "", "wasUseful": false }.
6. Máximo 1-3 oraciones concisas. Mismo estilo y tono que la descripción existente.
7. Inicia con un marcador según corresponda: "ESCENARIO ADICIONAL:", "EXCEPCIÓN:", "EJEMPLO:", "ACLARACIÓN:".

Responde ÚNICAMENTE JSON: { "addendum": "texto a agregar o cadena vacía", "wasUseful": true/false }`;

  try {
    const { result } = await callAI(prompt, 'Genera addendum para criterio de evaluación.');
    const addendum = result.addendum || '';
    const wasUseful = result.wasUseful === true && addendum.trim().length > 10;
    return { addendum: addendum.trim(), wasUseful };
  } catch (err) {
    console.error(`[B2B Agent] refineTemplateDescription error:`, err.message);
    return null;
  }
}

async function distillFilterFeedback(rawFeedback, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'filter');
  const prompt = `Analiza este feedback de un auditor humano. 
Si el auditor indica que la interacción fue mal clasificada (ej: "Era para Pagos, no Factura"), extrae una REGLA DE CLASIFICACIÓN concisa para el futuro.
Si el feedback NO trata sobre clasificación o asignación de agente, responde NO_VALOR.
Feedback: "${rawFeedback}"`;

  try {
    const { result: distilled } = await callAI(prompt, "Extrae regla de clasificación o responde NO_VALOR.");
    const text = distilled.rule || distilled.regla || distilled.categoria || (typeof distilled === 'string' ? distilled : '');
    if (!text || text.includes('NO_VALOR')) return null;
    return text;
  } catch (err) {
    return null;
  }
}

async function generateSystemPrompt(description, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'filter');
  const { result } = await callAI(`Genera criterios de evaluación CX para: ${description}. Responde JSON { "system_prompt": "..." }`, "Generar prompt.");
  return result.system_prompt || '';
}

async function suggestAgentName(description, aiConfig) {
  const { callAI } = createAIClient(aiConfig, 'filter');
  const { result } = await callAI(`Sugiere nombre corto (2-4 palabras) para: ${description}. Responde JSON { "name": "..." }`, "Sugerir nombre.");
  return result.name || '';
}

module.exports = {
  createAIClient,
  filterInteraction,
  analyzeInteraction,
  reprocessInteraction,
  selectiveReprocessInteraction,
  detectAffectedCriteriaByFeedback,
  generateSystemPrompt,
  suggestAgentName,
  distillFeedback,
  distillFilterFeedback,
  refineTemplateDescription,
  findDescriptionKey,
  findCriterionNameKey,
  normalizeName,
  buildFullPromptV2,
  buildFullPrompt,
  FIXED_QUALITY_PROMPT,
  BASE_ANALYSIS_PROMPT,
  DEFAULT_DELIVERABLE_TEMPLATE
};
