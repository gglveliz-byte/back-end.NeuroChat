#!/usr/bin/env node
/**
 * Script para probar el pipeline de transcripción B2B con un archivo de audio local.
 * Uso (desde la carpeta backend/):
 *   node scripts/test-b2b-transcription.js "ruta/al/audio.mp3"
 *
 * Variables de entorno (.env en backend/):
 *   GROQ_API_KEY     - Transcripción (gratis). Si no está, usa OpenAI.
 *   OPENAI_API_KEY   - Opcional: para diarización (Asesor/Cliente/Sistema).
 *
 * Salida: transcripción cruda, métricas de voz, calidad, y si hay API key, diarización.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const audioPath = process.argv[2];
if (!audioPath || !fs.existsSync(audioPath)) {
  console.error('Uso: node scripts/test-b2b-transcription.js "ruta/al/audio.mp3"');
  console.error('El archivo debe existir.');
  process.exit(1);
}

const fullPath = path.resolve(audioPath);
const buffer = fs.readFileSync(fullPath);
const fileName = path.basename(fullPath);

// Config opcional para diarización (Asesor/Cliente/Sistema)
let clientAIConfig = null;
if (process.env.OPENAI_API_KEY) {
  clientAIConfig = {
    ai_provider: 'openai',
    ai_api_key: process.env.OPENAI_API_KEY,
    ai_model: process.env.OPENAI_API_MODEL || 'gpt-4o-mini'
  };
}

async function main() {
  const { transcribeAudioFromBufferFull, diarizeTranscription, formatVoiceMetrics } = require('../src/services/b2bTranscriptionService');

  console.log('--- Prueba pipeline B2B ---');
  console.log('Archivo:', fullPath);
  console.log('Tamaño:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
  console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'Sí' : 'No');
  console.log('Diarización (OpenAI):', clientAIConfig ? 'Sí' : 'No (sin OPENAI_API_KEY)');
  console.log('');

  const start = Date.now();

  const result = await transcribeAudioFromBufferFull(buffer, fileName, clientAIConfig);
  const { rawText, metricsText, voiceMetrics } = result;

  let diarizedText = rawText;
  if (clientAIConfig && rawText && rawText.length > 50) {
    console.log('Ejecutando diarización (Asesor/Cliente/Sistema)...');
    diarizedText = await diarizeTranscription(rawText, clientAIConfig, metricsText);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log(`Tiempo total: ${elapsed}s`);
  console.log('');

  // Calidad
  const q = voiceMetrics.transcriptionQuality || {};
  console.log('=== CALIDAD DE TRANSCRIPCIÓN ===');
  console.log(`Nivel: ${q.level || 'N/A'} (${q.score ?? '?'}/100)`);
  if (q.issues && q.issues.length) {
    q.issues.forEach(i => console.log('  !', i));
  }
  console.log('');

  console.log('=== MÉTRICAS DE VOZ (resumen) ===');
  console.log(metricsText.split('\n').slice(0, 25).join('\n'));
  console.log('');

  console.log('=== TRANSCRIPCIÓN CRUDA (primeros 2000 caracteres) ===');
  console.log(rawText.slice(0, 2000) + (rawText.length > 2000 ? '\n...' : ''));
  console.log('');

  if (diarizedText !== rawText) {
    console.log('=== DIARIZACIÓN (Asesor / Cliente / [Sistema]) ===');
    console.log(diarizedText.slice(0, 3000) + (diarizedText.length > 3000 ? '\n...' : ''));
  }

  // Guardar resultado en archivo para revisión
  const outDir = path.join(__dirname, '..', 'test-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(fullPath, path.extname(fullPath));
  const outFile = path.join(outDir, `transcription_${base}_${Date.now()}.txt`);
  fs.writeFileSync(outFile, [
    '=== CALIDAD ===',
    JSON.stringify(q, null, 2),
    '',
    '=== MÉTRICAS ===',
    metricsText,
    '',
    '=== TRANSCRIPCIÓN CRUDA ===',
    rawText,
    '',
    '=== DIARIZACIÓN ===',
    diarizedText
  ].join('\n'), 'utf8');
  console.log('');
  console.log('Resultado completo guardado en:', outFile);
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.response?.data) console.error(err.response.data);
  process.exit(1);
});
