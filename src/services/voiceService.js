/**
 * voiceService.js
 * Pipeline completo de Voz IA para llamadas de WhatsApp Business
 *
 * Flujo por llamada:
 *  1. transcribeAudio()  — Groq Whisper: audio → texto (gratis)
 *  2. generateVoiceResponse() — GPT-4o mini: texto → respuesta
 *  3. generateTTS()       — OpenAI TTS tts-1: texto → audio MP3
 *  4. saveAudioFile()     — guarda MP3 en uploads/voice/{callId}/
 *
 * Costos estimados por llamada de 3 min (5 intercambios):
 *  - Groq Whisper:   $0.000  (free tier)
 *  - GPT-4o mini:    $0.0035
 *  - OpenAI TTS:     $0.0005
 *  - TOTAL:          ~$0.004
 */

const OpenAI = require('openai');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================================================
// CONSTANTES DE VOZ
// =====================================================
const VOICE_MODELS = {
  TTS: 'tts-1',           // Optimizado para velocidad (baja latencia)
  TTS_HD: 'tts-1-hd',    // Alta calidad (más lento, para grabaciones)
  WHISPER: 'whisper-large-v3-turbo',
};

const DEFAULT_VOICE = 'nova';   // nova = voz femenina natural en español
const MAX_EXCHANGE_BEFORE_WARN = 8;   // Avisar que queda poco tiempo
const MAX_EXCHANGE_HARD_LIMIT = 15;   // Transferir si supera esto

// Frases que disparan transferencia a humano
const TRANSFER_TRIGGERS = [
  'hablar con una persona', 'hablar con alguien', 'agente humano',
  'operador', 'asesor', 'con el gerente', 'con el dueño',
  'persona real', 'no quiero el bot', 'quiero hablar con',
  'me comunicas', 'transfiereme', 'comunícame',
];

// Frases de despedida que cierran la llamada
const GOODBYE_TRIGGERS = [
  'adiós', 'adios', 'hasta luego', 'chao', 'bye', 'gracias nada más',
  'eso es todo', 'no gracias', 'ya no necesito', 'ya está',
];

// =====================================================
// DIRECTORIO DE AUDIO TEMPORAL
// =====================================================
const VOICE_DIR = path.join(__dirname, '../../uploads/voice');

function ensureVoiceDir(callId) {
  const dir = path.join(VOICE_DIR, callId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// =====================================================
// 1. STT — Transcripción de audio
// Usa Groq Whisper (gratis) si GROQ_API_KEY está configurado,
// sino usa OpenAI Whisper ($0.006/min) — ya incluido en OPENAI_API_KEY
// =====================================================

/**
 * Descarga audio de una URL (Voximplant storage) y lo transcribe.
 * Proveedor automático: Groq (gratis) → OpenAI Whisper (fallback)
 * @param {string} audioUrl  URL del audio en Voximplant storage
 * @param {string} language  Código de idioma (default: 'es')
 * @returns {Promise<string>} Texto transcripto
 */
async function transcribeVoiceAudio(audioUrl, language = 'es') {
  // Descargar audio desde Voximplant
  const response = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'NeuroChat-Voice/1.0' },
  });

  const audioBuffer = Buffer.from(response.data);
  const mimeType = response.headers['content-type']?.split(';')[0] || 'audio/mpeg';
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'mp3';
  const file = new File([audioBuffer], `voice.${ext}`, { type: mimeType });

  let text = '';

  if (process.env.GROQ_API_KEY) {
    // Opción A: Groq Whisper — GRATIS
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const result = await groq.audio.transcriptions.create({
      file,
      model: VOICE_MODELS.WHISPER,
      language,
      response_format: 'text',
    });
    text = typeof result === 'string' ? result.trim() : result?.text?.trim() || '';
    console.log(`🎤 [Voice STT/Groq] "${text.substring(0, 80)}"`);
  } else {
    // Opción B: OpenAI Whisper — $0.006/min (ya tienes la API key)
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language,
      response_format: 'text',
    });
    text = typeof result === 'string' ? result.trim() : result?.text?.trim() || '';
    console.log(`🎤 [Voice STT/OpenAI] "${text.substring(0, 80)}"`);
  }

  return text;
}

// =====================================================
// 2. LLM — Generar respuesta con GPT-4o mini
// =====================================================

/**
 * Detecta si el usuario quiere transferencia a humano.
 */
function detectTransferRequest(text) {
  const lower = text.toLowerCase();
  return TRANSFER_TRIGGERS.some(trigger => lower.includes(trigger));
}

/**
 * Detecta si el usuario se está despidiendo.
 */
function detectGoodbye(text) {
  const lower = text.toLowerCase();
  return GOODBYE_TRIGGERS.some(trigger => lower.includes(trigger));
}

/**
 * Genera respuesta de IA para la llamada de voz.
 * Las respuestas son más cortas y conversacionales que en chat de texto.
 *
 * @param {string} userText        Texto del usuario (transcripto)
 * @param {object} botConfig       Config del bot del cliente
 * @param {Array}  callHistory     Historial [{role, content}]
 * @param {Array}  knowledgeChunks Chunks de RAG relevantes
 * @param {number} exchangeCount   Número de intercambio actual
 * @returns {Promise<{text, action, transferPhone}>}
 */
async function generateVoiceResponse(userText, botConfig, callHistory, knowledgeChunks = [], exchangeCount = 1) {
  // Verificar si pide transferencia antes de llamar a la IA
  if (detectTransferRequest(userText)) {
    return {
      text: null,
      action: 'transfer',
      reason: 'user_requested',
    };
  }

  // Verificar despedida
  if (detectGoodbye(userText)) {
    return {
      text: `¡Con mucho gusto! ${botConfig.farewell_message || 'Que tengas un excelente día. ¡Hasta pronto!'}`,
      action: 'hangup',
      reason: 'user_goodbye',
    };
  }

  // Límite duro de intercambios — transferir
  if (exchangeCount >= MAX_EXCHANGE_HARD_LIMIT) {
    return {
      text: null,
      action: 'transfer',
      reason: 'exchange_limit',
    };
  }

  // Construir system prompt para voz (más conciso que el de chat)
  const businessName = botConfig.business_name || 'el negocio';
  const botName = botConfig.bot_name || 'Asistente';
  const basePrompt = botConfig.system_prompt || `Eres el asistente virtual de ${businessName}.`;

  let systemPrompt = `Eres ${botName}, el asistente de voz de ${businessName}.
MODO: Llamada de WhatsApp. Respuestas CORTAS y NATURALES (máximo 2-3 oraciones).
No uses listas, viñetas ni formato markdown — esto es una llamada de voz.
No uses emojis.
Sé conversacional, cálido y directo.

${basePrompt}`;

  // Agregar conocimiento base si hay chunks relevantes
  if (knowledgeChunks.length > 0) {
    const context = knowledgeChunks.map(c => c.content).join('\n---\n');
    systemPrompt += `\n\nINFORMACIÓN DEL NEGOCIO (usa esto para responder):\n${context}`;
  }

  // Aviso de tiempo si se acerca al límite
  if (exchangeCount >= MAX_EXCHANGE_BEFORE_WARN) {
    systemPrompt += `\n\nIMPORTANTE: Quedan pocas preguntas disponibles en esta llamada. Si el tema es complejo, ofrece continuar por WhatsApp.`;
  }

  // Construir mensajes
  const messages = [
    { role: 'system', content: systemPrompt },
    ...callHistory.slice(-10), // últimos 10 intercambios
    { role: 'user', content: userText },
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 150,   // Respuestas cortas para llamadas de voz
    temperature: 0.7,
  });

  const responseText = completion.choices[0]?.message?.content?.trim() || '';
  const usage = completion.usage;

  console.log(`🤖 [Voice LLM] Respuesta generada (${usage?.total_tokens} tokens): "${responseText.substring(0, 80)}"`);

  return {
    text: responseText,
    action: 'respond',
    usage: {
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
    },
  };
}

// =====================================================
// 3. TTS — Convertir texto a audio MP3
// =====================================================

/**
 * Genera audio MP3 desde texto usando OpenAI TTS tts-1.
 * Guarda el archivo en uploads/voice/{callId}/ y retorna la URL pública.
 *
 * @param {string} text      Texto a convertir
 * @param {string} callId    ID de la llamada (para organizar archivos)
 * @param {string} voice     Voz OpenAI: alloy|echo|fable|onyx|nova|shimmer
 * @param {string} filename  Nombre del archivo (sin extensión)
 * @returns {Promise<string>} URL pública del archivo de audio
 */
async function generateTTS(text, callId, voice = DEFAULT_VOICE, filename = null) {
  if (!text || text.trim().length === 0) {
    throw new Error('TTS: texto vacío');
  }

  const dir = ensureVoiceDir(callId);
  const fname = filename || `tts_${Date.now()}`;
  const filePath = path.join(dir, `${fname}.mp3`);

  // Generar audio con OpenAI TTS
  const response = await openai.audio.speech.create({
    model: VOICE_MODELS.TTS,
    voice,
    input: text,
    response_format: 'mp3',
  });

  // Guardar archivo
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  // Retornar URL pública (servida via Express static)
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
  const publicUrl = `${backendUrl}/uploads/voice/${callId}/${fname}.mp3`;

  console.log(`🔊 [Voice TTS] Audio generado: ${fname}.mp3 (${buffer.length} bytes)`);
  return publicUrl;
}

// =====================================================
// 4. PIPELINE COMPLETO — Una función que hace todo
// =====================================================

/**
 * Procesa audio del usuario: STT → LLM → TTS
 * Retorna la URL del audio de respuesta y la acción a tomar.
 *
 * @returns {Promise<{action, audioUrl, text, message, transferPhone, usage}>}
 */
async function processVoiceTurn(params) {
  const {
    audioUrl,
    callId,
    botConfig,
    callHistory,
    knowledgeChunks,
    exchangeCount,
    voiceConfig,
    language = 'es',
  } = params;

  const voice = voiceConfig?.voice || DEFAULT_VOICE;

  // 1. STT — Transcribir audio del usuario
  let userText;
  try {
    userText = await transcribeVoiceAudio(audioUrl, language);
  } catch (err) {
    console.error('[Voice STT] Error:', err.message);
    // Si falla la transcripción, pedir que repitan
    const retryAudioUrl = await generateTTS(
      'Disculpa, no pude escucharte bien. ¿Podrías repetirlo?',
      callId, voice, `retry_${Date.now()}`
    );
    return { action: 'retry', audioUrl: retryAudioUrl, text: '' };
  }

  // Si Whisper no capturó nada (silencio, ruido)
  if (!userText || userText.length < 2) {
    const retryAudioUrl = await generateTTS(
      '¿Sigues ahí? ¿En qué puedo ayudarte?',
      callId, voice, `silence_${Date.now()}`
    );
    return { action: 'retry', audioUrl: retryAudioUrl, text: '' };
  }

  // 2. LLM — Generar respuesta
  const llmResult = await generateVoiceResponse(
    userText, botConfig, callHistory, knowledgeChunks, exchangeCount
  );

  // 3. Manejar acción especial (transfer / hangup)
  if (llmResult.action === 'transfer') {
    const transferPhone = voiceConfig?.transfer_phone;
    const backupPhone = voiceConfig?.transfer_phone_backup;
    const transferMsg = voiceConfig?.transfer_message ||
      'Voy a conectarte con un asesor. Un momento, por favor.';

    const transferAudioUrl = await generateTTS(transferMsg, callId, voice, `transfer_${Date.now()}`);

    return {
      action: 'transfer',
      audioUrl: transferAudioUrl,
      message: transferMsg,
      transferPhone: transferPhone || backupPhone || null,
      backupPhone,
      reason: llmResult.reason,
      userText,
    };
  }

  if (llmResult.action === 'hangup') {
    const goodbyeAudioUrl = await generateTTS(llmResult.text, callId, voice, `goodbye_${Date.now()}`);
    return {
      action: 'hangup',
      audioUrl: goodbyeAudioUrl,
      message: llmResult.text,
      userText,
    };
  }

  // 4. TTS — Convertir respuesta a audio
  const responseAudioUrl = await generateTTS(
    llmResult.text, callId, voice, `response_${exchangeCount}_${Date.now()}`
  );

  return {
    action: 'respond',
    audioUrl: responseAudioUrl,
    text: llmResult.text,
    userText,
    usage: llmResult.usage,
  };
}

// =====================================================
// 5. BIENVENIDA — Generar audio de saludo inicial
// =====================================================

/**
 * Genera el audio de bienvenida para una nueva llamada.
 */
async function generateWelcomeAudio(botConfig, voiceConfig, callId) {
  const businessName = botConfig?.business_name || 'el negocio';
  const botName = botConfig?.bot_name || 'Asistente';
  const customWelcome = voiceConfig?.welcome_message;
  const voice = voiceConfig?.voice || DEFAULT_VOICE;

  const welcomeText = customWelcome ||
    `Hola, soy ${botName} de ${businessName}. ¿En qué puedo ayudarte hoy?`;

  const audioUrl = await generateTTS(welcomeText, callId, voice, 'welcome');
  return { audioUrl, text: welcomeText };
}

// =====================================================
// 6. LIMPIEZA — Borrar archivos de audio de una llamada
// =====================================================

/**
 * Elimina todos los archivos de audio de una llamada (limpieza post-llamada).
 * Se llama con delay para dar tiempo a que Voximplant descargue los archivos.
 */
function cleanupCallAudio(callId, delayMs = 120000) {
  setTimeout(() => {
    try {
      const dir = path.join(VOICE_DIR, callId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        console.log(`🧹 [Voice] Audio cleanup: ${callId}`);
      }
    } catch (err) {
      console.error('[Voice] Cleanup error:', err.message);
    }
  }, delayMs);
}

// =====================================================
// 7. CÁLCULO DE COSTOS DE VOZ
// =====================================================

/**
 * Calcula costo operativo de una llamada de voz.
 * @param {number} durationSeconds  Duración de la llamada en segundos
 * @param {number} totalExchanges   Número de intercambios con IA
 */
function calculateVoiceCost(durationSeconds, totalExchanges) {
  const durationMinutes = durationSeconds / 60;

  // Voximplant WhatsApp calling: $0.004/min
  const voximplantCost = durationMinutes * 0.004;

  // GPT-4o mini estimado (1600 input + 300 output tokens por intercambio)
  const llmCost = totalExchanges * ((1600 / 1000) * 0.00015 + (300 / 1000) * 0.0006);

  // OpenAI TTS tts-1: $0.015/1K chars, ~200 chars por respuesta
  const ttsCost = totalExchanges * (200 / 1000) * 0.015;

  const totalCost = voximplantCost + llmCost + ttsCost;

  // Precio al cliente (x5 markup)
  const billedAmount = totalCost * 5;

  return {
    cost_usd: parseFloat(totalCost.toFixed(6)),
    billed_usd: parseFloat(billedAmount.toFixed(6)),
    breakdown: {
      voximplant: parseFloat(voximplantCost.toFixed(6)),
      llm: parseFloat(llmCost.toFixed(6)),
      tts: parseFloat(ttsCost.toFixed(6)),
    },
  };
}

module.exports = {
  transcribeVoiceAudio,
  generateVoiceResponse,
  generateTTS,
  generateWelcomeAudio,
  processVoiceTurn,
  cleanupCallAudio,
  calculateVoiceCost,
  detectTransferRequest,
  detectGoodbye,
  DEFAULT_VOICE,
  VOICE_MODELS,
};
