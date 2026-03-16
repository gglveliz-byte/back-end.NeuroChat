#!/usr/bin/env node
/**
 * Prueba COMPLETA del pipeline B2B: desde audio hasta la calificación con plantilla.
 * Flujo: Audio → Transcripción → Diarización → Filtro → Análisis (IA con plantilla) → Resultado.
 *
 * Uso (desde backend/):
 *   node scripts/test-b2b-full-pipeline.js "ruta/al/audio.mp3"
 *
 * Requiere en .env: GROQ_API_KEY, OPENAI_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const audioPath = process.argv[2];
if (!audioPath || !fs.existsSync(audioPath)) {
  console.error('Uso: node scripts/test-b2b-full-pipeline.js "ruta/al/audio.mp3"');
  process.exit(1);
}

const fullPath = path.resolve(audioPath);
const buffer = fs.readFileSync(fullPath);
const fileName = path.basename(fullPath);

const aiConfig = process.env.OPENAI_API_KEY
  ? { ai_provider: 'openai', ai_api_key: process.env.OPENAI_API_KEY, ai_model: process.env.OPENAI_API_MODEL || 'gpt-4o-mini' }
  : null;

// Plantilla de ejemplo (criterios que la IA debe evaluar)
const MOCK_AGENT = {
  description: 'Evalúa llamadas de servicio al cliente (facturación, cancelación, soporte). Considera tono, empatía, tiempo de espera y cumplimiento de protocolo.',
  evaluation_template: `
Criterios estándar:
E1. Saludo y presentación (No Crítico, peso 0.4) — El asesor saluda e se identifica.
E2. Tono y amabilidad (No Crítico, peso 0.4) — Tono profesional y respetuoso.
E3. Empatía y contención emocional (Crítico, peso 0.6) — Reconoce la situación del cliente.
E4. Tiempo de espera al cliente (Crítico, peso 0.6) — No dejó al cliente esperando de más sin avisar.
E5. Escucha activa (Crítico, peso 0.6) — Confirmó datos y no interrumpió de forma brusca.
E6. Cierre y despedida (No Crítico, peso 0.4) — Despedida clara y próximos pasos si aplica.
`,
  deliverable_template: 'JSON con observacion_audio, criterios (id, nombre, cumple, puntaje, observacion), puntaje_total, puntaje_maximo, porcentaje, resumen, puntos_criticos_fallidos.',
  feedback_accumulated: ''
};

async function main() {
  const { transcribeAudioFromBufferFull, diarizeTranscription, formatVoiceMetrics } = require('../src/services/b2bTranscriptionService');
  const { filterInteraction, analyzeInteraction } = require('../src/services/b2bAgentService');

  if (!aiConfig) {
    console.error('Se necesita OPENAI_API_KEY en .env para filtro y análisis.');
    process.exit(1);
  }
  if (!process.env.GROQ_API_KEY) {
    console.error('Se necesita GROQ_API_KEY en .env para transcripción.');
    process.exit(1);
  }

  console.log('========================================');
  console.log('  PRUEBA COMPLETA PIPELINE B2B');
  console.log('  Audio → Transcripción → Diarización → Filtro → Calificación con plantilla');
  console.log('========================================');
  console.log('Archivo:', fullPath);
  console.log('');

  const start = Date.now();

  // ─── 1. Transcripción + métricas ───
  console.log('[1/4] Transcripción (Groq Whisper) + métricas de voz (ffmpeg)...');
  const { rawText, metricsText, voiceMetrics } = await transcribeAudioFromBufferFull(buffer, fileName, aiConfig);
  console.log('      OK:', rawText.length, 'caracteres,', (voiceMetrics.totalWords || 0), 'palabras');

  // ─── 2. Diarización ───
  console.log('[2/4] Diarización (Asesor / Cliente / Sistema)...');
  const diarizedText = await diarizeTranscription(rawText, aiConfig, metricsText);
  console.log('      OK:', diarizedText.length, 'caracteres');

  // ─── 3. Filtro (clasificar área) ───
  console.log('[3/4] Filtro (clasificación de categoría)...');
  const agentNames = ['Facturación', 'Cancelación', 'No Navega', 'Otro'];
  const filterResult = await filterInteraction(diarizedText.slice(0, 8000), null, aiConfig, agentNames);
  console.log('      OK:', filterResult.categoria, '(confidence:', filterResult.confidence + ')');
  console.log('      Razón:', filterResult.razon);

  // ─── 4. Análisis con plantilla (calificación) ───
  console.log('[4/4] Análisis con plantilla (calificación por criterios)...');
  const analysisText = diarizedText + '\n\n' + metricsText;
  const agentResult = await analyzeInteraction(analysisText, MOCK_AGENT, aiConfig);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('');
  console.log('========================================');
  console.log('  RESULTADO DE LA CALIFICACIÓN (con plantilla)');
  console.log('========================================');
  console.log('Tiempo total:', elapsed, 's');
  console.log('');

  if (agentResult.porcentaje != null) {
    console.log('Puntaje:', agentResult.puntaje_total, '/', agentResult.puntaje_maximo, '→', agentResult.porcentaje.toFixed(1) + '%');
    console.log('Calificación (1-10):', agentResult.calificacion);
    console.log('Cumple protocolo:', agentResult.cumple_protocolo ? 'Sí' : 'No');
  } else {
    console.log('Calificación (1-10):', agentResult.calificacion);
    console.log('Cumple protocolo:', agentResult.cumple_protocolo);
  }
  console.log('');
  console.log('Observación (contexto emocional/audio):', agentResult.observacion_audio || '(no indicada)');
  console.log('');
  console.log('Resumen:', agentResult.resumen || '(no indicado)');
  if (Array.isArray(agentResult.puntos_criticos_fallidos) && agentResult.puntos_criticos_fallidos.length) {
    console.log('Criterios críticos fallidos:', agentResult.puntos_criticos_fallidos.join(', '));
  }
  console.log('');

  if (Array.isArray(agentResult.criterios) && agentResult.criterios.length) {
    console.log('--- Criterios evaluados (plantilla) ---');
    for (const c of agentResult.criterios) {
      const cumple = c.cumple ? 'Sí' : 'No';
      const punt = c.puntaje != null ? c.puntaje : '-';
      console.log(`  ${c.id || '-'} ${c.nombre || '-'}: ${cumple} (puntaje ${punt}) — ${(c.observacion || '').slice(0, 60)}`);
    }
  }

  const outDir = path.join(__dirname, '..', 'test-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(fullPath, path.extname(fullPath));
  const outFile = path.join(outDir, `full_pipeline_${base}_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    filterResult,
    agentResult,
    transcriptionLength: rawText.length,
    diarizedLength: diarizedText.length,
    elapsedSec: parseFloat(elapsed)
  }, null, 2), 'utf8');
  console.log('');
  console.log('Resultado completo guardado en:', outFile);
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.response?.data) console.error(err.response.data);
  process.exit(1);
});
