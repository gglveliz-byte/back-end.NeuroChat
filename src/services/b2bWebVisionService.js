/**
 * B2B Web Vision Service
 * 
 * Uses GPT-4o-mini to analyze screenshots and provide navigation instructions.
 */

const OpenAI = require('openai');
const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');

/**
 * Get OpenAI client (preferring platform key for simplicity in Phase 1)
 */
async function getPlatformOpenAI() {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Analyze a screenshot to decide the next navigation step.
 * 
 * @param {Buffer} imageBuffer - Screenshot as buffer
 * @returns {Promise<{action: string, x?: number, y?: number, explanation: string}>}
 */
async function analyzeNavigationStep(imageBuffer) {
    const openai = await getPlatformOpenAI();
    const base64Image = imageBuffer.toString('base64');

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Eres un experto en navegación web. Tu objetivo es guiar a un bot para extraer información valiosa de planes y precios.
Analiza la captura de pantalla y decide la siguiente acción.
Formatos de respuesta (solo JSON):
- Si ves un popup/anuncio bloqueando: {"action": "CLICK", "x": 123, "y": 456, "explanation": "Cerrando modal de publicidad"}
- Si ves botones de "Ver detalles" o "Pestañas" que ocultan info: {"action": "CLICK", "x": 123, "y": 456, "explanation": "Expandiendo detalles del plan"}
- Si necesitas ver más contenido abajo: {"action": "SCROLL", "explanation": "Buscando más planes abajo"}
- Si la página muestra toda la información valiosa claramente: {"action": "READY", "explanation": "Información capturada correctamente"}

IMPORTANTE: Devuelve COORDENADAS RELATIVAS a la imagen (en píxeles).`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '¿Qué debo hacer ahora para obtener toda la información de planes y precios?' },
                    {
                        type: 'image_url',
                        image_url: { url: `data:image/png;base64,${base64Image}` }
                    }
                ]
            }
        ],
        response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
}

module.exports = {
    analyzeNavigationStep
};
