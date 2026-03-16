const Groq = require('groq-sdk');
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { execSync } = require('child_process');
const { decrypt } = require('../utils/encryption');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ─── B2B Transcription Service v6 (WhisperX + Fallback) ─────────
//
// Pipeline (WhisperX — PRIMARY):
//   1. Send audio to WhisperX microservice (local PC or VPS)
//   2. WhisperX does: VAD → Transcription → Alignment → Diarization
//   3. Returns JSON masticado: transcript, segments, silences, voice_metrics
//   4. ffmpeg adds volume/raised voice analysis (complementary)
//   5. NO GPT diarization needed — WhisperX already identifies speakers
//
// Fallback (when WhisperX is down):
//   1. Convert to mp3 96k mono 16kHz
//   2. Smart split by silence → Groq/OpenAI Whisper
//   3. GPT diarization
//
// Priority: WhisperX (local) > Groq Whisper (free) > Client OpenAI key > Error

const WHISPERX_URL = process.env.WHISPERX_URL || 'http://localhost:8765';
const WHISPERX_API_KEY = process.env.WHISPERX_API_KEY || 'whisperx-secret-key-change-me';
const FormData = require('form-data');

const MAX_WHISPER_SIZE = 24 * 1024 * 1024; // 24MB
const MAX_CHUNK_SECS = 300; // max 5 min per chunk (Whisper sweet spot)
const MIN_CHUNK_SECS = 120; // min 2 min per chunk (avoid too-short chunks)
const CHUNK_OVERLAP_SECS = 5; // 5s overlap between chunks to avoid cutting words

// ─── Audio conversion ───────────────────────────────────────────

function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = inputPath.replace(/\.[^.]+$/, '_converted.mp3');
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(96)
      .audioChannels(1)
      .audioFrequency(16000)
      .on('end', () => {
        console.log('[B2B Transcription] ffmpeg conversion complete');
        resolve(outPath);
      })
      .on('error', reject)
      .save(outPath);
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 0);
    });
  });
}

// ─── Smart splitting by silence ─────────────────────────────────
// Instead of fixed intervals, detect silences FIRST with ffmpeg,
// then extract only speech segments. This prevents:
//   - Cutting mid-sentence (splits happen at natural pauses)
//   - Whisper hallucinating on silent sections (silence is skipped)
//   - Loss of context (each segment has complete phrases)

/**
 * Detect all silences in the audio using ffmpeg silencedetect
 * @returns {Array<{start: number, end: number, duration: number}>}
 */
function detectSilences(mp3Path) {
  try {
    const stderr = execSync(
      `"${ffmpegPath}" -i "${mp3Path}" -af silencedetect=noise=-32dB:d=1.5 -f null ${process.platform === 'win32' ? 'NUL' : '/dev/null'} 2>&1`,
      { encoding: 'utf8', timeout: 120000 }
    );
    const silences = [];
    const regex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let match;
    while ((match = regex.exec(stderr))) {
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      silences.push({ start, end, duration: Math.round((end - start) * 10) / 10 });
    }
    return silences;
  } catch {
    return [];
  }
}

/**
 * Build speech segments from detected silences
 * Each segment = a range of audio that has actual speech
 * @returns {Array<{start: number, end: number, silenceAfter: number}>}
 */
function buildSpeechSegments(silences, totalDuration) {
  if (silences.length === 0) {
    // No silences detected — treat entire audio as one speech segment
    return [{ start: 0, end: totalDuration, silenceAfter: 0 }];
  }

  const segments = [];
  let cursor = 0;

  for (const silence of silences) {
    // Speech segment from cursor to start of silence
    if (silence.start - cursor >= 1) {
      segments.push({
        start: cursor,
        end: silence.start,
        silenceAfter: Math.round(silence.duration * 10) / 10
      });
    }
    cursor = silence.end;
  }

  // Last speech segment after final silence
  if (totalDuration - cursor >= 1) {
    segments.push({ start: cursor, end: totalDuration, silenceAfter: 0 });
  }

  return segments;
}

/**
 * Merge adjacent short speech segments to avoid tiny chunks (< MIN_CHUNK_SECS)
 * and split overly long segments (> MAX_CHUNK_SECS) at silence boundaries
 * @returns {Array<{start: number, end: number, silences: Array}>}
 */
function optimizeSpeechSegments(segments) {
  if (segments.length === 0) return [];

  const MIN_SEGMENT = 30; // Don't create segments shorter than 30s
  const optimized = [];
  let current = { start: segments[0].start, end: segments[0].end, silences: [] };

  if (segments[0].silenceAfter > 0) {
    current.silences.push(segments[0].silenceAfter);
  }

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const currentDuration = current.end - current.start;
    const segDuration = seg.end - seg.start;
    const combinedDuration = seg.end - current.start;
    const silenceBetween = segments[i - 1].silenceAfter || 0;

    // Merge if: combined would be under MAX_CHUNK_SECS AND (segment is short OR silence between is short)
    if (combinedDuration <= MAX_CHUNK_SECS && (segDuration < MIN_SEGMENT || silenceBetween < 3)) {
      // Merge: extend current to include this segment
      current.end = seg.end;
      if (seg.silenceAfter > 0) current.silences.push(seg.silenceAfter);
    } else {
      // Finalize current, start new
      optimized.push(current);
      current = { start: seg.start, end: seg.end, silences: [] };
      if (seg.silenceAfter > 0) current.silences.push(seg.silenceAfter);
    }
  }
  optimized.push(current);

  return optimized;
}

/**
 * Extract speech-only audio segments as separate mp3 files
 * @returns {Array<{path: string, start: number, end: number, duration: number, silenceAfter: number}>}
 */
async function smartSplitBySilence(mp3Path, duration) {
  console.log(`[B2B Transcription] Detecting silences in ${(duration / 60).toFixed(1)}min audio...`);
  const silences = detectSilences(mp3Path);
  console.log(`[B2B Transcription] Found ${silences.length} silence(s)`);

  const rawSegments = buildSpeechSegments(silences, duration);
  const segments = optimizeSpeechSegments(rawSegments);

  // If only 1 segment and it covers most of the audio, just use the full file
  if (segments.length === 1 && (segments[0].end - segments[0].start) > duration * 0.9) {
    console.log(`[B2B Transcription] Audio is mostly speech — using full file`);
    return [{ path: mp3Path, start: 0, end: duration, duration: Math.round(duration), silenceAfter: 0, isOriginal: true }];
  }

  // Extract each speech segment to a separate mp3
  const chunks = [];
  const promises = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDuration = seg.end - seg.start;
    if (segDuration < 1) continue;

    const chunkPath = mp3Path.replace('.mp3', `_speech${i}.mp3`);
    const lastSilence = seg.silences.length > 0 ? seg.silences[seg.silences.length - 1] : 0;

    chunks.push({
      path: chunkPath,
      start: seg.start,
      end: seg.end,
      duration: Math.round(segDuration),
      silenceAfter: lastSilence,
      isOriginal: false
    });

    promises.push(new Promise((resolve, reject) => {
      ffmpeg(mp3Path)
        .setStartTime(seg.start)
        .duration(segDuration)
        .audioCodec('libmp3lame')
        .audioBitrate(96)
        .on('end', resolve)
        .on('error', reject)
        .save(chunkPath);
    }));
  }

  await Promise.all(promises);

  const totalSpeech = chunks.reduce((s, c) => s + c.duration, 0);
  const totalSkipped = Math.round(duration - totalSpeech);
  const durations = chunks.map(c => `${(c.duration / 60).toFixed(1)}min`).join(', ');
  console.log(`[B2B Transcription] Smart split: ${chunks.length} speech segments [${durations}], skipped ${totalSkipped}s of silence`);

  return chunks;
}

// Legacy fixed splitting (fallback if silence detection fails)
function splitIntoChunks(filePath, duration) {
  const numChunks = Math.max(1, Math.ceil(duration / MAX_CHUNK_SECS));
  const baseChunkDuration = Math.ceil(duration / numChunks);

  const chunks = [];
  const promises = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i === 0 ? 0 : Math.max(0, i * baseChunkDuration - CHUNK_OVERLAP_SECS);
    const end = Math.min(duration, (i + 1) * baseChunkDuration + (i < numChunks - 1 ? CHUNK_OVERLAP_SECS : 0));
    const chunkDuration = end - start;
    if (chunkDuration < 1) break;

    const chunkPath = filePath.replace('.mp3', `_chunk${i}.mp3`);
    chunks.push({ path: chunkPath, start, duration: Math.round(chunkDuration) });

    promises.push(new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .setStartTime(start)
        .duration(chunkDuration)
        .audioCodec('libmp3lame')
        .audioBitrate(96)
        .on('end', resolve)
        .on('error', reject)
        .save(chunkPath);
    }));
  }

  return Promise.all(promises).then(() => {
    const durations = chunks.map(c => `${(c.duration / 60).toFixed(1)}min`).join(', ');
    console.log(`[B2B Transcription] Fallback split into ${chunks.length} equal chunks: [${durations}]`);
    return chunks;
  });
}

// ─── Groq client ────────────────────────────────────────────────

function getGroqClient() {
  if (!process.env.GROQ_API_KEY) return null;
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// ─── Whisper transcription (PLAIN TEXT mode) ────────────────────

// Prompt rico para mayor precisión: español latinoamericano, call center, habla coloquial
const WHISPER_PROMPT = `Llamada telefónica atención al cliente, español ecuatoriano. Participantes: IVR, asesor, cliente. Vocabulario: cédula, factura, facturación, cancelación, plan, megas, internet, fibra óptica, no navega, decodificador, router, módem, reconexión, corte de servicio, débito automático, banco del barrio, link de pago, WhatsApp, ticket, requerimiento. Frases: "le saluda", "permítame un momento", "me confirma su cédula", "disculpe los malestares", "fue un gusto atenderle". Transcribe palabras completas. Si no se entiende, usa [inaudible].`;

const MIN_SILENCE_GAP = 2; // seconds — minimum gap between segments to mark as silence (2s captures meaningful pauses in calls)

/**
 * Process Whisper verbose_json response: filter hallucinations, detect real silences
 */
function processWhisperSegments(result) {
  let data;
  if (typeof result === 'string') {
    try { data = JSON.parse(result); } catch { return result.trim(); }
  } else {
    data = result;
  }

  const segments = data.segments;
  if (!segments || segments.length === 0) {
    return (data.text || '').trim();
  }

  // Filter hallucinations: no_speech_prob, avg_logprob, compression_ratio, short text, artifacts
  const filtered = segments.filter(seg => {
    const nsp = seg.no_speech_prob || 0;
    const logprob = seg.avg_logprob ?? 0;
    const comprRatio = seg.compression_ratio ?? 1;
    const text = (seg.text || '').trim();
    if (text.length === 0) return false;
    // High no-speech probability + short segment = likely hallucination
    if (nsp > 0.6 && text.length < 30) return false;
    // Even moderate no-speech with very short text
    if (nsp > 0.5 && text.length < 15) return false;
    // Very low confidence transcription (avg_logprob < -1.0 is poor quality)
    if (logprob < -1.0 && text.length < 20) return false;
    // High compression ratio = repetitive text = hallucination (normal speech ~1.0-2.5)
    if (comprRatio > 2.8 && nsp > 0.3) return false;
    // Combined low quality indicators
    if (nsp > 0.4 && logprob < -0.8 && text.length < 25) return false;
    // Common Whisper hallucinations on silent/music sections
    const lower = text.toLowerCase();
    if (/^(gracias por ver|suscr[ií]bete|subt[ií]tulos|music[ao]?|♪|🎵|thanks for watching|\.{2,})/i.test(lower)) return false;
    if (/^[.\s♪🎵]+$/.test(text)) return false; // just dots/music symbols/whitespace
    // Repetitive single-word hallucinations (e.g., "Sí. Sí. Sí. Sí.")
    const words = text.split(/\s+/);
    const unique = new Set(words.map(w => w.toLowerCase().replace(/[.,!?]/g, '')));
    if (words.length >= 4 && unique.size === 1) return false;
    return true;
  });

  // Remove consecutive repetitions (Whisper hallucination on silent/music sections)
  const deduped = [];
  let repeatCount = 0;
  for (let i = 0; i < filtered.length; i++) {
    const currText = filtered[i].text.trim().toLowerCase();
    const prevText = i > 0 ? filtered[i - 1].text.trim().toLowerCase() : '';
    if (currText === prevText) {
      repeatCount++;
      if (repeatCount >= 1) continue; // Skip 2nd+ repetition (stricter dedup)
    } else {
      repeatCount = 0;
    }
    deduped.push(filtered[i]);
  }

  // Build text with REAL silence markers between segments
  const parts = [];
  for (let i = 0; i < deduped.length; i++) {
    const seg = deduped[i];
    if (i > 0) {
      const prevEnd = deduped[i - 1].end || 0;
      const currStart = seg.start || 0;
      const gap = currStart - prevEnd;
      if (gap >= MIN_SILENCE_GAP) {
        parts.push(`[Silencio detectado: ${Math.round(gap)}s]`);
      }
    }
    parts.push(seg.text.trim());
  }

  const filteredOut = segments.length - deduped.length;
  const silenceCount = parts.filter(p => p.startsWith('[Silencio')).length;
  console.log(`[B2B Transcription] Segments: ${deduped.length}/${segments.length} kept (${filteredOut} filtered), ${silenceCount} real silences detected`);

  return parts.join(' ');
}

async function transcribeChunk(filePath, clientAIConfig = null) {
  // Try 1: Groq Whisper (free) — verbose_json for timestamps + silence detection
  const groq = getGroqClient();
  if (groq) {
    try {
      const result = await groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-large-v3-turbo',
        language: 'es',
        response_format: 'verbose_json',
        temperature: 0.0,
        prompt: WHISPER_PROMPT
      });
      const text = processWhisperSegments(result);
      if (text.length > 0) {
        console.log(`[B2B Transcription] Groq success: ${text.length} chars`);
        return postProcessTranscription(text);
      }
    } catch (groqErr) {
      console.warn('[B2B Transcription] Groq failed, trying OpenAI fallback:', groqErr.message);
    }
  } else {
    console.log('[B2B Transcription] GROQ_API_KEY not set, using OpenAI fallback...');
  }

  // Try 2: Client's OpenAI key
  if (clientAIConfig && clientAIConfig.ai_api_key) {
    let apiKey;
    try { apiKey = decrypt(clientAIConfig.ai_api_key); } catch { apiKey = clientAIConfig.ai_api_key; }
    if (!apiKey) throw new Error('Client AI API key is empty after decryption');

    const openai = new OpenAI({ apiKey });
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      language: 'es',
      response_format: 'verbose_json',
      temperature: 0.0,
      prompt: WHISPER_PROMPT
    });
    const text = processWhisperSegments(result);
    if (text.length > 0) {
      console.log(`[B2B Transcription] OpenAI success: ${text.length} chars`);
      return postProcessTranscription(text);
    }
    throw new Error('OpenAI transcription returned empty text');
  }

  throw new Error('No transcription provider available. Configure GROQ_API_KEY in .env or assign an OpenAI API key to the B2B client.');
}

// Corrige truncamientos frecuentes de Whisper (palabras cortadas al final)
function postProcessTranscription(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  const fixes = [
    // Truncamientos de -ción
    [/\bcancelaci(?:on|ón)?\b/gi, 'cancelación'],
    [/\bfacturaci(?:on|ón)?\b/gi, 'facturación'],
    [/\batenci(?:on|ón)?\b/gi, 'atención'],
    [/\boperaci(?:on|ón)?\b/gi, 'operación'],
    [/\breconecsi(?:on|ón)?\b/gi, 'reconexión'],
    [/\breconexsi(?:on|ón)?\b/gi, 'reconexión'],
    [/\binstalaci(?:on|ón)?\b/gi, 'instalación'],
    [/\bverificaci(?:on|ón)?\b/gi, 'verificación'],
    [/\bconfirmaci(?:on|ón)?\b/gi, 'confirmación'],
    [/\binformaci(?:on|ón)?\b/gi, 'información'],
    [/\bcomunicaci(?:on|ón)?\b/gi, 'comunicación'],
    [/\bpresentaci(?:on|ón)?\b/gi, 'presentación'],
    // Truncamientos de -mente
    [/\bactualm(?:ente)?\b/gi, 'actualmente'],
    [/\bcorrectam(?:ente)?\b/gi, 'correctamente'],
    [/\bpreviament(?:e)?\b/gi, 'previamente'],
    [/\bsolament(?:e)?\b/gi, 'solamente'],
    [/\bdirectam(?:ente)?\b/gi, 'directamente'],
    // Truncamientos de -ión
    [/\btelevisi(?:on|ón)?\b/gi, 'televisión'],
    [/\bconecsi(?:on|ón)?\b/gi, 'conexión'],
    [/\bconexsi(?:on|ón)?\b/gi, 'conexión'],
    // Acentos faltantes
    [/\btelefon(?:o|ó)\b/gi, 'teléfono'],
    [/\bcedula\b/gi, 'cédula'],
    [/\bnumer(?:o|ó)\b/gi, 'número'],
    [/\bdebito\b/gi, 'débito'],
    // Errores fonéticos comunes
    [/\bfioscos?\b/gi, 'kioscos'],
    [/\bquioscos?\b/gi, 'kioscos'],
    [/\bwester(?:n)?\b/gi, 'Western Union'],
    // Limpiar artefactos de Whisper
    [/\b(Subtítulos|Subtitulos|Subtitulado por)\b.*$/gim, ''],
    [/♪+/g, ''],
    [/🎵+/g, ''],
    [/\(música\)/gi, '[música de espera]'],
    [/\(music\)/gi, '[música de espera]'],
  ];
  for (const [regex, replacement] of fixes) {
    out = out.replace(regex, replacement);
  }
  // Remove multiple spaces
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
}

// ─── Voice metrics (ffmpeg - $0 cost) ───────────────────────────

function getVolumeForRange(filePath, startSec, endSec) {
  return new Promise((resolve) => {
    const duration = Math.max(0.5, endSec - startSec);
    let rmsSum = 0, rmsCount = 0;

    ffmpeg(filePath)
      .setStartTime(startSec)
      .duration(duration)
      .audioFilters('astats=metadata=1:reset=1')
      .format('null')
      .on('stderr', (line) => {
        const m = line.match(/RMS level dB:\s*([-\d.]+)/);
        if (m) { const v = parseFloat(m[1]); if (isFinite(v)) { rmsSum += v; rmsCount++; } }
      })
      .on('end', () => resolve(rmsCount > 0 ? rmsSum / rmsCount : -30))
      .on('error', () => resolve(-30))
      .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
      .run();
  });
}

async function analyzeVoiceMetrics(mp3Path, duration) {
  console.log('[B2B Transcription] Analyzing voice metrics...');

  // ─── 1. Sample volume every 10 seconds (more granular) ───
  const volumePoints = [];
  const sampleInterval = 10; // every 10s instead of 30s
  for (let t = 2; t < duration - 2; t += sampleInterval) {
    const vol = await getVolumeForRange(mp3Path, t, t + 3);
    volumePoints.push({ timeSec: Math.round(t), rmsDb: Math.round(vol * 10) / 10 });
  }

  const avgVolume = volumePoints.length > 0
    ? volumePoints.reduce((s, v) => s + v.rmsDb, 0) / volumePoints.length
    : -30;
  const loudMoments = volumePoints.filter(v => v.rmsDb > avgVolume + 6);
  const quietMoments = volumePoints.filter(v => v.rmsDb < -45); // very quiet = possible hold/mute

  // ─── 2. Detect ALL silences (>2s short, >5s long/hold) ───
  const silences = [];
  try {
    const stderr = execSync(
      `"${ffmpegPath}" -i "${mp3Path}" -af silencedetect=noise=-32dB:d=1.5 -f null ${process.platform === 'win32' ? 'NUL' : '/dev/null'} 2>&1`,
      { encoding: 'utf8', timeout: 60000 }
    );
    const regex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let match;
    while ((match = regex.exec(stderr))) {
      const start = parseFloat(match[1]);
      const end = parseFloat(match[2]);
      const dur = end - start;
      silences.push({
        startSec: Math.round(start),
        endSec: Math.round(end),
        duration: Math.round(dur * 10) / 10,
        type: dur >= 15 ? 'hold' : dur >= 5 ? 'espera_larga' : dur >= 3 ? 'pausa' : 'micropausa'
      });
    }
  } catch { /* ignore */ }

  // ─── 3. Calculate derived metrics ───
  const totalSilenceTime = silences.reduce((s, x) => s + x.duration, 0);
  const holdTime = silences.filter(s => s.type === 'hold').reduce((s, x) => s + x.duration, 0);
  const speechTime = Math.max(0, Math.round(duration) - totalSilenceTime);
  const holds = silences.filter(s => s.type === 'hold');
  const longPauses = silences.filter(s => s.type === 'espera_larga');
  const shortPauses = silences.filter(s => s.type === 'pausa');
  const microPauses = silences.filter(s => s.type === 'micropausa');

  // ─── 4. Volume timeline (grouped in 1-min blocks for readability) ───
  const minuteBlocks = [];
  const totalMinutes = Math.ceil(duration / 60);
  for (let m = 0; m < totalMinutes; m++) {
    const blockPoints = volumePoints.filter(v => v.timeSec >= m * 60 && v.timeSec < (m + 1) * 60);
    if (blockPoints.length > 0) {
      const blockAvg = blockPoints.reduce((s, v) => s + v.rmsDb, 0) / blockPoints.length;
      const blockMax = Math.max(...blockPoints.map(v => v.rmsDb));
      minuteBlocks.push({
        minute: m + 1,
        avgDb: Math.round(blockAvg * 10) / 10,
        maxDb: Math.round(blockMax * 10) / 10,
        activity: blockAvg > avgVolume + 3 ? 'activo' : blockAvg < -42 ? 'silencioso' : 'normal'
      });
    }
  }

  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  const metrics = {
    totalDuration: Math.round(duration),
    speechTime,
    holdTime,
    totalSilenceTime,
    avgVolumeDb: Math.round(avgVolume * 10) / 10,
    // Raised voice (potential frustration/emphasis)
    raisedVoiceMoments: loudMoments.length,
    raisedVoiceDetails: loudMoments.map(v => ({
      at: fmtTime(v.timeSec),
      timeSec: v.timeSec,
      db: v.rmsDb
    })),
    // All silence events categorized
    silenceCount: silences.length,
    holds: holds.map(s => ({
      at: fmtTime(s.startSec),
      duration: s.duration,
      timeSec: s.startSec
    })),
    longPauses: longPauses.map(s => ({
      at: fmtTime(s.startSec),
      duration: s.duration,
      timeSec: s.startSec
    })),
    shortPauses: shortPauses.length,
    microPauses: microPauses.length,
    // Per-minute volume timeline
    volumeTimeline: minuteBlocks,
    // Interruption indicators (rapid loud moments close together)
    interruptions: loudMoments.filter((v, i) => i > 0 && v.timeSec - loudMoments[i - 1].timeSec < 15).length,
    // Words per minute estimate (filled after transcription text is available)
    avgWordsPerMinute: 0
  };

  console.log(`[B2B Transcription] Voice metrics: speech ${Math.round(speechTime / 60)}min, hold ${Math.round(holdTime / 60)}min, ${metrics.raisedVoiceMoments} raised voice, ${silences.length} silences, ${metrics.interruptions} interruptions`);
  return metrics;
}

function formatVoiceMetrics(metrics) {
  if (!metrics) return '';

  const durMin = Math.floor(metrics.totalDuration / 60);
  const durSec = metrics.totalDuration % 60;
  const speechMin = Math.floor(metrics.speechTime / 60);
  const holdMin = Math.floor(metrics.holdTime / 60);
  const holdSec = metrics.holdTime % 60;

  const lines = [
    '[METRICAS DE AUDIO - datos reales del audio analizado por ffmpeg]',
    '',
    `TIEMPOS:`,
    `- Duracion total: ${durMin}min ${durSec}s`,
    `- Tiempo de habla: ${speechMin}min ${metrics.speechTime % 60}s`,
    `- Tiempo en espera/hold: ${holdMin}min ${holdSec}s`,
    `- Velocidad de habla: ${metrics.avgWordsPerMinute || 0} palabras/min (${metrics.totalWords || 0} palabras totales)`,
    '',
    `VOLUMEN Y EMOCIONES:`,
    `- Volumen promedio: ${metrics.avgVolumeDb}dB`,
    `- Momentos de voz elevada (posible frustracion/enfasis): ${metrics.raisedVoiceMoments}`,
  ];

  if (metrics.raisedVoiceDetails && metrics.raisedVoiceDetails.length > 0) {
    for (const v of metrics.raisedVoiceDetails) {
      lines.push(`  * ${v.at} — volumen ${v.db}dB (elevado)`);
    }
  }

  lines.push(`- Posibles interrupciones (voz elevada rapida consecutiva): ${metrics.interruptions || 0}`);
  lines.push('');
  lines.push('SILENCIOS Y ESPERAS:');
  lines.push(`- Total silencios detectados: ${metrics.silenceCount || 0}`);

  if (metrics.holds && metrics.holds.length > 0) {
    lines.push(`- Esperas en hold (>15s):`);
    for (const h of metrics.holds) {
      lines.push(`  * ${h.at} — ${h.duration}s en espera`);
    }
  }

  if (metrics.longPauses && metrics.longPauses.length > 0) {
    lines.push(`- Pausas largas (5-15s):`);
    for (const p of metrics.longPauses) {
      lines.push(`  * ${p.at} — ${p.duration}s de pausa`);
    }
  }

  lines.push(`- Pausas cortas (3-5s): ${metrics.shortPauses || 0}`);
  lines.push(`- Micropausas (1.5-3s): ${metrics.microPauses || 0}`);

  lines.push('');
  lines.push('INSTRUCCION PARA LA IA: Usa estos datos para evaluar emociones, tono y tiempos de espera.');
  lines.push('- Hold y pausas largas = tiempo que el cliente pudo estar esperando (correlaciona con la transcripcion: si tras el silencio retoma el Asesor, el asesor puso al cliente en espera).');
  lines.push('- Voz elevada por minuto = posible frustracion o enfasis; interrupciones = posible tension.');
  lines.push('- Linea de tiempo por minuto: activo = hay habla, silencioso = espera o pausa.');

  // Volume timeline per minute
  if (metrics.volumeTimeline && metrics.volumeTimeline.length > 0) {
    lines.push('');
    lines.push('LINEA DE TIEMPO DE ACTIVIDAD (por minuto):');
    for (const block of metrics.volumeTimeline) {
      const indicator = block.activity === 'activo' ? '▲' : block.activity === 'silencioso' ? '▽' : '─';
      lines.push(`  Min ${block.minute}: ${indicator} promedio ${block.avgDb}dB, max ${block.maxDb}dB [${block.activity}]`);
    }
  }

  // Transcription quality warning
  if (metrics.transcriptionQuality) {
    const q = metrics.transcriptionQuality;
    if (q.level !== 'buena') {
      lines.push('');
      lines.push(`ADVERTENCIA DE CALIDAD DE TRANSCRIPCION: ${q.level.toUpperCase()} (${q.score}/100)`);
      for (const issue of q.issues) {
        lines.push(`  ! ${issue}`);
      }
      lines.push('NOTA: La transcripcion puede contener errores. Algunos criterios pueden no ser evaluables con precision. Si no puedes determinar algo, indicalo en la observacion.');
    }
  }

  return lines.join('\n');
}

// ─── GPT Diarization ────────────────────────────────────────────

const DIARIZE_SYSTEM_PROMPT = `Eres un experto en diarizacion de llamadas de call center en Latinoamerica (Ecuador).
Recibes el texto COMPLETO de una llamada y metricas de audio. Tu tarea: asignar CORRECTAMENTE quien habla en cada fragmento.

═══ LOS 3 TIPOS DE HABLANTE ═══

[Sistema]: Voz pregrabada, automatizada. Incluye:
- IVR/menus: "para X marca Y", "si desea hablar con un agente presione..."
- Grabaciones legales: "esta llamada esta siendo grabada", "para fines de calidad"
- Encuestas automaticas al final: "del 1 al 5 califique...", "presione 1 si..."
- Musica de espera o mensajes pregrabados durante holds
- Mensajes automaticos de sistema: "su llamada sera transferida", "todos nuestros asesores estan ocupados"
CLAVE: Voz robótica/uniforme, frases repetitivas/estandarizadas, no interactúa con el contenido de la conversación

Asesor: Empleado del call center. Se identifica por:
- Presenta su nombre y empresa al inicio: "le saluda [nombre] de [empresa]", "buenos días mi nombre es..."
- PIDE datos al cliente: "me confirma su cédula", "a nombre de quién está el servicio", "me puede dar su correo"
- CONSULTA el sistema: "permítame revisar", "déjeme verificar en el sistema", "voy a revisar su cuenta"
- DA soluciones/instrucciones: "lo que vamos a hacer es...", "le voy a generar un ticket", "su caso queda registrado"
- USA lenguaje corporativo: "disculpe los malestares", "en nombre de la empresa le ofrezco disculpas"
- EXPLICA procedimientos/políticas: "el proceso es de 24 a 48 horas", "los pagos se realizan los primeros 10 días"
- PONE en espera: "permítame un momento", "me regala unos minutos"
- RETOMA después de esperas: "gracias por la espera", "ya verifiqué su caso"
CLAVE: Tono profesional/formal, tiene acceso a información del sistema, guía la conversación

Cliente: Persona que llama para resolver algo. Se identifica por:
- EXPLICA su problema: "no tengo internet", "me llegó una factura muy alta", "hace 3 días que no tengo servicio"
- DA sus datos cuando se los piden: dice su cédula, nombre, dirección, correo
- SE IDENTIFICA como familiar: "yo soy hijo/hija de...", "la cuenta está a nombre de mi esposa"
- HACE preguntas: "¿cuándo se me va a solucionar?", "¿por qué me cobraron eso?", "¿dónde puedo pagar?"
- MUESTRA emociones: frustración ("no tengo plata", "ya llamé 5 veces"), urgencia, enojo, preocupación
- HABLA de su vida personal: "tengo hijos", "trabajo desde casa", "necesito el internet para..."
- CONFIRMA o niega: "sí, correcto", "no, esa no es mi dirección", "ajá"
CLAVE: Tiene el problema, da datos personales, hace preguntas, muestra emociones, no tiene acceso al sistema

═══ ESTRUCTURA TÍPICA DE LLAMADA ═══
1. [Sistema] IVR — menus automaticos (puede durar 1-3 minutos)
2. Asesor saluda — "le saluda [nombre]", "buenas tardes" (SIEMPRE es el primero en hablar después del IVR)
3. Cliente responde — saluda y explica por qué llama (SIEMPRE es el segundo después del IVR)
4. Asesor pide datos — valida identidad, consulta sistema
5. Cliente da datos — cédula, nombre, etc.
6. Asesor investiga — puede poner en espera
7. Asesor da solución/información
8. Cliente reacciona — acepta, reclama, pregunta más
9. Cierre — Asesor resume y se despide, Cliente agradece
10. [Sistema] encuesta post-llamada (si aplica)

═══ REGLAS CRÍTICAS DE IDENTIFICACIÓN ═══

TURNOS DE CONVERSACIÓN:
- Después del IVR, la PRIMERA voz humana = SIEMPRE Asesor
- La SEGUNDA voz humana = SIEMPRE Cliente
- Los turnos generalmente se ALTERNAN (Asesor → Cliente → Asesor → Cliente)
- Si hay 2 turnos seguidos del mismo hablante, es porque uno hizo una pausa y continuó

QUIÉN PIDE vs QUIÉN DA DATOS:
- Quien PIDE cédula/nombre/dirección/correo = Asesor (está validando)
- Quien DICE su cédula/nombre/dirección = Cliente (está respondiendo)
- Quien CONFIRMA datos leyéndolos del sistema ("me registra que usted tiene...") = Asesor
- Quien CONFIRMA si son correctos ("sí, correcto", "no, ese no es") = Cliente

CONTENIDO QUE DEFINE AL CLIENTE (nunca es Asesor):
- Problemas personales: "no tengo internet", "no me llega la factura", "me cortaron"
- Emociones/vida personal: "no tengo plata", "tengo hijos", "estoy desesperado"
- Preguntas sobre su servicio: "¿cuánto debo?", "¿cuándo se arregla?"
- Identificación familiar: "soy hijo/hija de", "la cuenta de mi mamá/papá/esposo"

CONTENIDO QUE DEFINE AL ASESOR (nunca es Cliente):
- Acciones en sistema: "voy a generar un ticket", "queda registrado", "le voy a enviar"
- Políticas empresa: "el proceso toma X horas", "los pagos son los primeros 10 días"
- Ofertas/opciones: "le puedo ofrecer", "los puntos de pago son"
- Solicitud de espera: "permítame un momento", "me regala unos minutos"

═══ SILENCIOS Y ESPERAS ═══
- [Silencio detectado: Xs] son MEDICIONES REALES del audio — NO los modifiques ni inventes
- Convierte cada uno a [Espera: ~Xs] y colócalo entre los hablantes apropiados
- Después de una espera larga, quien retoma = generalmente Asesor ("gracias por la espera")
- NO inventes esperas que no estén marcadas en el texto

═══ MÉTRICAS DE AUDIO ═══
- Voz elevada = probable frustración del Cliente o énfasis
- Interrupciones (voz alta consecutiva rápida) = posible tensión en la conversación
- Usa los minutos de actividad para ubicar cambios de tono

═══ ERRORES COMUNES (EVÍTALOS) ═══
- NO confundir Cliente con Asesor porque el Cliente saluda formalmente ("buenas tardes")
- NO asumir que quien da información detallada es Asesor — el Cliente también explica con detalle SU situación
- El Asesor NUNCA dice: "no tengo plata", "tengo hijos", "¿dónde pago?", "mi mamá"
- El Cliente NUNCA dice: "permítame revisar en el sistema", "le voy a generar un ticket", "disculpe los malestares"
- Si hay texto incoherente/sin sentido (alucinación de Whisper) = OMITIR COMPLETAMENTE

═══ FORMATO DE SALIDA ═══
[Sistema]: texto del IVR o mensaje automatizado
Asesor: texto del asesor
Cliente: texto del cliente
[Espera: ~Xs] entre hablantes donde haya silencio real

REGLAS FINALES:
- Responde ÚNICAMENTE con la transcripción diarizada
- NO agregues comentarios, métricas, ni explicaciones
- NO inventes esperas — solo usa los [Silencio detectado: Xs] del texto
- OMITE texto incoherente o basura de transcripción
- Mantén el texto COMPLETO de cada turno — no resumas ni omitas contenido válido`;

async function diarizeTranscription(rawText, clientAIConfig, metricsText = '') {
  if (!clientAIConfig || !clientAIConfig.ai_api_key) {
    console.log('[B2B Transcription] No AI config for diarization, returning raw text');
    return rawText;
  }

  try {
    let apiKey;
    try { apiKey = decrypt(clientAIConfig.ai_api_key); } catch { apiKey = clientAIConfig.ai_api_key; }

    const openai = new OpenAI({ apiKey });
    const model = clientAIConfig.ai_model || 'gpt-4o-mini';

    // For very long texts, split into chunks for diarization
    const MAX_DIARIZE_CHARS = 12000;
    const textChunks = [];
    if (rawText.length <= MAX_DIARIZE_CHARS) {
      textChunks.push(rawText);
    } else {
      // Split at sentence boundaries
      const sentences = rawText.match(/[^.!?]+[.!?]+\s*/g) || [rawText];
      let current = '';
      for (const s of sentences) {
        if (current.length + s.length > MAX_DIARIZE_CHARS && current.length > 0) {
          textChunks.push(current);
          current = '';
        }
        current += s;
      }
      if (current) textChunks.push(current);
    }

    console.log(`[B2B Transcription] Diarizing ${rawText.length} chars in ${textChunks.length} chunk(s)...`);

    const diarizedParts = [];
    let previousContext = '';

    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      const isFirst = i === 0;

      let userMessage = '';
      if (isFirst && metricsText) {
        userMessage += `${metricsText}\n\n`;
      }
      if (!isFirst && previousContext) {
        userMessage += `[CONTEXTO PREVIO — NO incluir, solo para continuidad]\n${previousContext}\n\n---\n\n`;
      }
      userMessage += `${isFirst ? 'Formatea esta transcripcion de llamada de servicio al cliente' : 'Continua con la siguiente parte de la misma llamada'}:\n\n${chunk}`;

      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: DIARIZE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 8000
      });

      const result = response.choices[0].message.content;
      if (result && result.trim().length > 20) {
        diarizedParts.push(result.trim());
        const lines = result.trim().split('\n').filter(l => l.trim());
        previousContext = lines.slice(-4).join('\n');
      } else {
        diarizedParts.push(chunk);
      }

      console.log(`[B2B Transcription] Diarization chunk ${i + 1}/${textChunks.length} complete`);
    }

    const fullDiarized = diarizedParts.join('\n\n');
    console.log(`[B2B Transcription] Diarization complete: ${fullDiarized.length} chars`);
    return fullDiarized;

  } catch (diarizeErr) {
    console.error('[B2B Transcription] Diarization failed:', diarizeErr.message);
    return rawText;
  }
}

// ─── Transcription Quality Assessment ─────────────────────────────

function assessTranscriptionQuality(rawText, duration, voiceMetrics) {
  let score = 100;
  const issues = [];

  const wordCount = voiceMetrics.totalWords || 0;
  const wpm = voiceMetrics.avgWordsPerMinute || 0;
  const speechTime = voiceMetrics.speechTime || 0;
  const durationMin = duration / 60;

  // 1. Too few words for the duration (audio barely has speech)
  if (wordCount < 20) {
    score -= 50;
    issues.push('Muy pocas palabras detectadas - audio posiblemente sin habla clara');
  } else if (wpm < 40 && durationMin > 1) {
    score -= 25;
    issues.push('Velocidad muy baja - posible audio con mucho silencio o musica de espera');
  }

  // 2. Too much silence vs duration (mostly hold/IVR)
  const silenceRatio = voiceMetrics.totalSilenceTime / Math.max(1, duration);
  if (silenceRatio > 0.7) {
    score -= 20;
    issues.push(`${Math.round(silenceRatio * 100)}% del audio es silencio - posible llamada en espera`);
  }

  // 3. Check for truncated words (words ending abruptly - common Whisper artifact)
  const words = rawText.split(/\s+/);
  const truncated = words.filter(w => w.length >= 4 && /[^aeiouáéíóúns.]$/i.test(w) && !/\d/.test(w));
  const truncatedRatio = truncated.length / Math.max(1, words.length);
  if (truncatedRatio > 0.15) {
    score -= 15;
    issues.push('Posibles palabras cortadas/truncadas en la transcripcion');
  }

  // 4. Check for repetitive text (Whisper hallucination on silent/music sections)
  const sentences = rawText.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 3) {
    const unique = new Set(sentences.map(s => s.trim().toLowerCase()));
    const repetitionRatio = 1 - (unique.size / sentences.length);
    if (repetitionRatio > 0.3) {
      score -= 20;
      issues.push('Texto repetitivo detectado - posible alucinacion de Whisper en secciones sin habla');
    }
  }

  // 5. Very short audio with lots of IVR text (mostly system, little conversation)
  const ivrKeywords = ['marca 1', 'marca 2', 'marca 3', 'signo numeral', 'esta llamada', 'para contratar'];
  const ivrCount = ivrKeywords.filter(k => rawText.toLowerCase().includes(k)).length;
  if (ivrCount >= 3 && wordCount < 100) {
    score -= 15;
    issues.push('Audio mayormente IVR con poca conversacion real');
  }

  // 6. Low volume audio (hard to hear = hard to transcribe)
  if (voiceMetrics.avgVolumeDb < -40) {
    score -= 10;
    issues.push('Volumen muy bajo - transcripcion puede tener errores');
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (score >= 80) level = 'buena';
  else if (score >= 50) level = 'aceptable';
  else if (score >= 25) level = 'baja';
  else level = 'muy_baja';

  return { score, level, issues };
}

// ─── WhisperX Remote Transcription ──────────────────────────────

/**
 * Call WhisperX microservice for transcription + diarization
 * Returns fully processed result (transcript, voice_metrics, silences)
 * @param {string} filePath - Path to audio file
 * @returns {Promise<{rawText: string, metricsText: string, voiceMetrics: object, whisperxUsed: boolean}>}
 */
async function transcribeWithWhisperX(filePath) {
  const url = `${WHISPERX_URL}/transcribe`;
  console.log(`[B2B Transcription] Calling WhisperX at ${WHISPERX_URL}...`);

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));

  const response = await axios.post(url, formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${WHISPERX_API_KEY}`
    },
    timeout: 600000, // 10 min max (long audios on CPU can take a while)
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  const data = response.data;
  if (!data.success) {
    throw new Error(`WhisperX error: ${data.detail || 'Unknown error'}`);
  }

  console.log(`[B2B Transcription] WhisperX response: ${data.segments?.length} segments, ${data.voice_metrics?.speakersDetected} speakers, ${data.processing?.total_time}s processing`);

  // The transcript from WhisperX already has speaker labels (SPEAKER_00, SPEAKER_01, etc.)
  // We'll use it directly — no GPT diarization needed
  const rawText = data.transcript || '';
  const voiceMetrics = data.voice_metrics || {};

  // Add volume analysis from ffmpeg (WhisperX doesn't do volume/raised voice)
  // This will be done separately in the pipeline if needed

  const metricsText = formatWhisperXMetrics(voiceMetrics);

  return {
    rawText,
    metricsText,
    voiceMetrics,
    whisperxUsed: true,
    segments: data.segments || [],
    silences: data.silences || [],
    processing: data.processing || {}
  };
}

/**
 * Send audio to WhisperX async endpoint (returns immediately, result comes via callback)
 * @param {string} filePath - Path to audio file
 * @param {string} interactionId - Interaction ID for callback routing
 * @returns {Promise<{accepted: boolean, jobId: string}>}
 */
async function transcribeWithWhisperXAsync(filePath, interactionId) {
  const url = `${WHISPERX_URL}/transcribe-async`;
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
  const callbackUrl = `${backendUrl}/api/v1/b2b/whisperx-callback`;

  console.log(`[B2B Transcription] Sending async request to WhisperX at ${WHISPERX_URL}...`);
  console.log(`[B2B Transcription] Callback URL: ${callbackUrl}`);

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('callback_url', callbackUrl);
  formData.append('interaction_id', interactionId);

  const response = await axios.post(url, formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${WHISPERX_API_KEY}`
    },
    timeout: 30000, // Only 30s — just upload time, not processing
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  const data = response.data;
  if (!data.accepted) {
    throw new Error(`WhisperX async rejected: ${JSON.stringify(data)}`);
  }

  console.log(`[B2B Transcription] WhisperX accepted job ${data.job_id} — processing in background`);
  return { accepted: true, jobId: data.job_id };
}

// ─── Pending WhisperX callbacks (resolve promises when callback arrives) ───
const pendingCallbacks = new Map(); // interactionId → { resolve, reject, timeout }

/**
 * Wait for WhisperX callback result (used by pipeline)
 * @param {string} interactionId
 * @param {number} maxWaitMs - Maximum wait time (default 15 min)
 * @returns {Promise<object>} WhisperX result data
 */
function waitForWhisperXCallback(interactionId, maxWaitMs = 900000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(interactionId);
      reject(new Error('WhisperX callback timeout — no response received'));
    }, maxWaitMs);

    pendingCallbacks.set(interactionId, { resolve, reject, timeout });
    console.log(`[B2B Transcription] Waiting for WhisperX callback for ${interactionId} (max ${maxWaitMs/1000}s)...`);
  });
}

/**
 * Called when WhisperX sends callback with transcription result
 * Resolves the pending promise so the pipeline continues
 * @param {string} interactionId
 * @param {object} data - WhisperX result
 */
function resolveWhisperXCallback(interactionId, data) {
  const pending = pendingCallbacks.get(interactionId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingCallbacks.delete(interactionId);

    if (data.success === false) {
      console.error(`[B2B Transcription] WhisperX callback error for ${interactionId}: ${data.error}`);
      pending.reject(new Error(`WhisperX processing failed: ${data.error}`));
    } else {
      console.log(`[B2B Transcription] WhisperX callback received for ${interactionId} — ${data.segments?.length || 0} segments`);
      pending.resolve(data);
    }
  } else {
    console.warn(`[B2B Transcription] Received callback for unknown interaction: ${interactionId}`);
  }
}

/**
 * Check if WhisperX service is available (also checks async support)
 */
async function isWhisperXAvailable() {
  try {
    const response = await axios.get(`${WHISPERX_URL}/health`, { timeout: 3000 });
    return response.data?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Check if WhisperX supports async mode
 */
async function isWhisperXAsyncAvailable() {
  try {
    const response = await axios.get(`${WHISPERX_URL}/health`, { timeout: 3000 });
    return response.data?.status === 'ok' && response.data?.async_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Format WhisperX voice metrics into text block for the quality agent
 */
function formatWhisperXMetrics(metrics) {
  if (!metrics) return '';

  const durMin = Math.floor((metrics.totalDuration || 0) / 60);
  const durSec = (metrics.totalDuration || 0) % 60;
  const speechMin = Math.floor((metrics.speechTime || 0) / 60);
  const holdMin = Math.floor((metrics.holdTime || 0) / 60);
  const holdSec = (metrics.holdTime || 0) % 60;

  const lines = [
    '[METRICAS DE AUDIO - datos de WhisperX (transcripcion + diarizacion)]',
    '',
    'TIEMPOS:',
    `- Duracion total: ${durMin}min ${durSec}s`,
    `- Tiempo de habla: ${speechMin}min ${(metrics.speechTime || 0) % 60}s`,
    `- Tiempo en espera/hold: ${holdMin}min ${holdSec}s`,
    `- Velocidad de habla: ${metrics.avgWordsPerMinute || 0} palabras/min (${metrics.totalWords || 0} palabras totales)`,
    `- Hablantes detectados: ${metrics.speakersDetected || 0}`,
    '',
    'SILENCIOS Y ESPERAS:',
    `- Total silencios detectados: ${metrics.silenceCount || 0}`,
  ];

  if (metrics.holds && metrics.holds.length > 0) {
    lines.push('- Esperas en hold (>15s):');
    for (const h of metrics.holds) {
      const at = `${Math.floor(h.start / 60)}:${String(Math.round(h.start % 60)).padStart(2, '0')}`;
      lines.push(`  * ${at} — ${h.duration}s en espera`);
    }
  }

  if (metrics.longPauses && metrics.longPauses.length > 0) {
    lines.push('- Pausas largas (5-15s):');
    for (const p of metrics.longPauses) {
      const at = `${Math.floor(p.start / 60)}:${String(Math.round(p.start % 60)).padStart(2, '0')}`;
      lines.push(`  * ${at} — ${p.duration}s de pausa`);
    }
  }

  lines.push(`- Pausas cortas (3-5s): ${metrics.shortPauses || 0}`);
  lines.push(`- Micropausas (1.5-3s): ${metrics.microPauses || 0}`);

  // Speaker stats
  if (metrics.speakerStats) {
    lines.push('');
    lines.push('ESTADISTICAS POR HABLANTE:');
    for (const [speaker, stats] of Object.entries(metrics.speakerStats)) {
      lines.push(`- ${speaker}: ${stats.speech_time}s habla, ${stats.word_count} palabras, ${stats.wpm} palabras/min, ${stats.segments} turnos`);
    }
  }

  lines.push('');
  if (metrics._speakersRemapped) {
    // Speakers already identified as Asesor/Cliente/[Sistema] — no ambiguity
    lines.push('NOTA: Los hablantes ya estan identificados en la transcripcion (Asesor, Cliente, [Sistema]).');
    lines.push('- Usa las estadisticas de cada hablante para evaluar tiempos de espera, atencion y calidad.');
    lines.push('- [Sistema] = IVR/bot automatizado, NO lo evalues como parte del desempeno del Asesor.');
  } else {
    lines.push('INSTRUCCION PARA LA IA: Los speakers (SPEAKER_00, SPEAKER_01, etc.) corresponden a los participantes de la llamada.');
    lines.push('- El primer speaker humano despues del IVR = generalmente Asesor');
    lines.push('- El segundo speaker humano = generalmente Cliente');
    lines.push('- Identifica quien es quien por el CONTENIDO de lo que dicen (quien pide datos = Asesor, quien da datos = Cliente)');
    lines.push('- Usa los tiempos de habla y silencios para evaluar tiempos de espera y atencion.');
  }

  return lines.join('\n');
}

// ─── Main transcription pipeline ────────────────────────────────

async function transcribeFromFile(tmpPath, clientAIConfig = null, interactionId = null, quality = 'high') {
  const tempFiles = [];
  const useWhisperX = quality === 'high';

  try {
    // ═══ TRY 1: WhisperX Async (primary — callback pattern) ═══
    // Sends audio to WhisperX, responds immediately, result comes via callback
    // SKIP if quality='fast' — go straight to Groq/OpenAI
    if (useWhisperX && interactionId) {
      const asyncAvailable = await isWhisperXAsyncAvailable();
      if (asyncAvailable) {
        try {
          console.log('[B2B Transcription] Using WhisperX ASYNC (callback pattern)...');
          await transcribeWithWhisperXAsync(tmpPath, interactionId);

          // Wait for callback (WhisperX will POST result to /b2b/whisperx-callback)
          const callbackData = await waitForWhisperXCallback(interactionId);

          // Process callback data same as sync
          const rawText = callbackData.transcript || '';
          const voiceMetrics = callbackData.voice_metrics || {};
          const metricsText = formatWhisperXMetrics(voiceMetrics);

          // Complement with ffmpeg volume analysis
          let mp3Path = tmpPath;
          if (!tmpPath.endsWith('.mp3')) {
            mp3Path = await convertToMp3(tmpPath);
            tempFiles.push(mp3Path);
          }
          const duration = await getAudioDuration(mp3Path);
          const volumeMetrics = await analyzeVolumeOnly(mp3Path, duration);

          voiceMetrics.avgVolumeDb = volumeMetrics.avgVolumeDb;
          voiceMetrics.raisedVoiceMoments = volumeMetrics.raisedVoiceMoments;
          voiceMetrics.raisedVoiceDetails = volumeMetrics.raisedVoiceDetails;
          voiceMetrics.interruptions = volumeMetrics.interruptions;
          voiceMetrics.volumeTimeline = volumeMetrics.volumeTimeline;

          const wordCount = rawText.split(/\s+/).filter(w => w.length > 0).length;
          console.log(`[B2B Transcription] WhisperX async complete: ${rawText.length} chars, ${wordCount} words`);

          return {
            rawText,
            metricsText: formatWhisperXMetrics(voiceMetrics),
            voiceMetrics,
            whisperxUsed: true,
            segments: callbackData.segments || [],
            silences: callbackData.silences || [],
            processing: callbackData.processing || {}
          };
        } catch (asyncErr) {
          console.warn(`[B2B Transcription] WhisperX async failed: ${asyncErr.message}. Trying sync fallback...`);
        }
      }
    }

    // ═══ TRY 2: WhisperX Sync (original — may timeout on ngrok) ═══
    const whisperxAvailable = useWhisperX && await isWhisperXAvailable();
    if (whisperxAvailable) {
      try {
        console.log('[B2B Transcription] Using WhisperX (sync)...');
        const wxResult = await transcribeWithWhisperX(tmpPath);

        // Complement with ffmpeg volume analysis (WhisperX doesn't measure volume/raised voice)
        let mp3Path = tmpPath;
        if (!tmpPath.endsWith('.mp3')) {
          mp3Path = await convertToMp3(tmpPath);
          tempFiles.push(mp3Path);
        }
        const duration = await getAudioDuration(mp3Path);
        const volumeMetrics = await analyzeVolumeOnly(mp3Path, duration);

        // Merge volume data into WhisperX metrics
        wxResult.voiceMetrics.avgVolumeDb = volumeMetrics.avgVolumeDb;
        wxResult.voiceMetrics.raisedVoiceMoments = volumeMetrics.raisedVoiceMoments;
        wxResult.voiceMetrics.raisedVoiceDetails = volumeMetrics.raisedVoiceDetails;
        wxResult.voiceMetrics.interruptions = volumeMetrics.interruptions;
        wxResult.voiceMetrics.volumeTimeline = volumeMetrics.volumeTimeline;

        // Rebuild metrics text with volume data included
        wxResult.metricsText = formatWhisperXMetrics(wxResult.voiceMetrics);

        const wordCount = wxResult.rawText.split(/\s+/).filter(w => w.length > 0).length;
        console.log(`[B2B Transcription] WhisperX pipeline complete: ${wxResult.rawText.length} chars, ${wordCount} words, ${wxResult.voiceMetrics.speakersDetected || 0} speakers`);

        return wxResult;
      } catch (wxErr) {
        console.warn(`[B2B Transcription] WhisperX failed: ${wxErr.message}. Falling back to Groq/OpenAI...`);
      }
    } else if (!useWhisperX) {
      console.log('[B2B Transcription] Fast mode — skipping WhisperX, using Groq/OpenAI...');
    } else {
      console.log('[B2B Transcription] WhisperX not available, using Groq/OpenAI fallback...');
    }

    // ═══ FALLBACK: Groq/OpenAI Whisper ════════════════════════
    console.log('[B2B Transcription] Converting audio to mp3...');
    const mp3Path = await convertToMp3(tmpPath);
    tempFiles.push(mp3Path);

    const fileSize = fs.statSync(mp3Path).size;
    const duration = await getAudioDuration(mp3Path);
    console.log(`[B2B Transcription] Converted: ${(fileSize / 1024 / 1024).toFixed(1)}MB, ${(duration / 60).toFixed(1)} min`);

    // Smart split by silence → transcribe only speech segments
    let rawText = '';
    let speechChunks;
    try {
      speechChunks = await smartSplitBySilence(mp3Path, duration);
    } catch (splitErr) {
      console.warn('[B2B Transcription] Smart split failed, falling back to fixed chunks:', splitErr.message);
      if (duration > MAX_CHUNK_SECS || fileSize > MAX_WHISPER_SIZE) {
        speechChunks = await splitIntoChunks(mp3Path, duration);
      } else {
        speechChunks = [{ path: mp3Path, start: 0, duration: Math.round(duration), silenceAfter: 0, isOriginal: true }];
      }
    }

    tempFiles.push(...speechChunks.filter(c => !c.isOriginal).map(c => c.path));

    if (speechChunks.length === 1 && speechChunks[0].isOriginal) {
      console.log('[B2B Transcription] Transcribing single file (no silence splitting needed)...');
      rawText = await transcribeChunk(mp3Path, clientAIConfig);
    } else {
      const parts = [];
      for (let i = 0; i < speechChunks.length; i++) {
        const chunk = speechChunks[i];
        console.log(`[B2B Transcription] Transcribing speech segment ${i + 1}/${speechChunks.length} (${chunk.duration}s from ${Math.round(chunk.start)}s)...`);
        const text = await transcribeChunk(chunk.path, clientAIConfig);
        if (text && text.trim().length > 0) parts.push(text.trim());
        if (chunk.silenceAfter && chunk.silenceAfter >= MIN_SILENCE_GAP && i < speechChunks.length - 1) {
          parts.push(`[Silencio detectado: ${Math.round(chunk.silenceAfter)}s]`);
        }
        if (i < speechChunks.length - 1) await new Promise(r => setTimeout(r, 500));
      }
      rawText = parts.join(' ');
    }

    console.log(`[B2B Transcription] Whisper fallback complete: ${rawText.length} chars`);

    const voiceMetrics = await analyzeVoiceMetrics(mp3Path, duration);
    const wordCount = rawText.split(/\s+/).filter(w => w.length > 0).length;
    voiceMetrics.avgWordsPerMinute = voiceMetrics.speechTime > 0
      ? Math.round(wordCount / (voiceMetrics.speechTime / 60))
      : Math.round(wordCount / (duration / 60));
    voiceMetrics.totalWords = wordCount;

    const txQuality = assessTranscriptionQuality(rawText, duration, voiceMetrics);
    voiceMetrics.transcriptionQuality = txQuality;

    const metricsText = formatVoiceMetrics(voiceMetrics);

    console.log(`[B2B Transcription] Fallback pipeline complete: ${rawText.length} chars, ${wordCount} words, quality: ${txQuality.level} (${txQuality.score}/100)`);
    return { rawText, metricsText, voiceMetrics, whisperxUsed: false };

  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { }
    }
  }
}

/**
 * Volume-only analysis (complement for WhisperX which doesn't measure volume)
 * Lighter than full analyzeVoiceMetrics — only volume, raised voice, interruptions
 */
async function analyzeVolumeOnly(mp3Path, duration) {
  const volumePoints = [];
  const sampleInterval = 10;
  for (let t = 2; t < duration - 2; t += sampleInterval) {
    const vol = await getVolumeForRange(mp3Path, t, t + 3);
    volumePoints.push({ timeSec: Math.round(t), rmsDb: Math.round(vol * 10) / 10 });
  }

  const avgVolume = volumePoints.length > 0
    ? volumePoints.reduce((s, v) => s + v.rmsDb, 0) / volumePoints.length
    : -30;
  const loudMoments = volumePoints.filter(v => v.rmsDb > avgVolume + 6);
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  // Per-minute volume timeline
  const minuteBlocks = [];
  const totalMinutes = Math.ceil(duration / 60);
  for (let m = 0; m < totalMinutes; m++) {
    const blockPoints = volumePoints.filter(v => v.timeSec >= m * 60 && v.timeSec < (m + 1) * 60);
    if (blockPoints.length > 0) {
      const blockAvg = blockPoints.reduce((s, v) => s + v.rmsDb, 0) / blockPoints.length;
      const blockMax = Math.max(...blockPoints.map(v => v.rmsDb));
      minuteBlocks.push({
        minute: m + 1,
        avgDb: Math.round(blockAvg * 10) / 10,
        maxDb: Math.round(blockMax * 10) / 10,
        activity: blockAvg > avgVolume + 3 ? 'activo' : blockAvg < -42 ? 'silencioso' : 'normal'
      });
    }
  }

  return {
    avgVolumeDb: Math.round(avgVolume * 10) / 10,
    raisedVoiceMoments: loudMoments.length,
    raisedVoiceDetails: loudMoments.map(v => ({ at: fmtTime(v.timeSec), timeSec: v.timeSec, db: v.rmsDb })),
    interruptions: loudMoments.filter((v, i) => i > 0 && v.timeSec - loudMoments[i - 1].timeSec < 15).length,
    volumeTimeline: minuteBlocks
  };
}

// ─── Public API ─────────────────────────────────────────────────

async function transcribeAudio(audioUrl, clientAIConfig = null) {
  const result = await transcribeAudioFull(audioUrl, clientAIConfig);
  return result.rawText;
}

async function transcribeAudioFull(audioUrl, clientAIConfig = null, interactionId = null, quality = 'high') {
  // Detect if audioUrl is a local file path or an HTTP URL
  const isLocalFile = !audioUrl.startsWith('http://') && !audioUrl.startsWith('https://');

  if (isLocalFile) {
    // Local file path (from queue upload) — use directly
    if (!fs.existsSync(audioUrl)) throw new Error(`Audio file not found: ${audioUrl}`);
    const stats = fs.statSync(audioUrl);
    if (stats.size === 0) throw new Error('Audio file is empty');
    console.log(`[B2B Transcription] Using local file: ${(stats.size / 1024 / 1024).toFixed(1)}MB (quality: ${quality})`);
    return await transcribeFromFile(audioUrl, clientAIConfig, interactionId, quality);
  }

  // HTTP URL — download first
  const urlPath = new URL(audioUrl).pathname;
  const urlExt = path.extname(urlPath) || '.mp3';
  const tmpPath = path.join(os.tmpdir(), `b2b_audio_${Date.now()}_${Math.random().toString(36).slice(2)}${urlExt}`);

  try {
    const response = await axios({ method: 'GET', url: audioUrl, responseType: 'stream', timeout: 300000 });
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmpPath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    const stats = fs.statSync(tmpPath);
    if (stats.size === 0) throw new Error('Downloaded audio file is empty');
    console.log(`[B2B Transcription] Downloaded ${(stats.size / 1024 / 1024).toFixed(1)}MB from URL`);
    return await transcribeFromFile(tmpPath, clientAIConfig, interactionId, quality);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
  }
}

async function transcribeAudioFromBuffer(audioBuffer, originalName = 'audio.mp3', clientAIConfig = null) {
  const result = await transcribeAudioFromBufferFull(audioBuffer, originalName, clientAIConfig);
  return result.rawText;
}

async function transcribeAudioFromBufferFull(audioBuffer, originalName = 'audio.mp3', clientAIConfig = null) {
  const ext = path.extname(originalName) || '.mp3';
  const tmpPath = path.join(os.tmpdir(), `b2b_upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

  try {
    fs.writeFileSync(tmpPath, audioBuffer);
    const stats = fs.statSync(tmpPath);
    if (stats.size === 0) throw new Error('Uploaded audio file is empty');
    console.log(`[B2B Transcription] Upload received: ${(stats.size / 1024 / 1024).toFixed(1)}MB (${originalName})`);
    return await transcribeFromFile(tmpPath, clientAIConfig);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
  }
}

// ─── WhisperX Speaker Remapping ──────────────────────────────────
// WhisperX diarization returns SPEAKER_00, SPEAKER_01 labels.
// This lightweight GPT call maps them to Asesor/Cliente/[Sistema] roles.
// Much cheaper than full diarization — only identifies who is who.

const REMAP_SPEAKERS_PROMPT = `Eres un EXPERTO en transcripción y diarización de llamadas de call center (Ecuador/Latinoamérica).

TU MISIÓN: Recibir una transcripción de WhisperX con etiquetas SPEAKER_00, SPEAKER_01, etc., y transformarla en una conversación perfecta y "masticada" para un Auditor de Calidad.

═══ LOS 3 ROLES (OBLIGATORIOS) ═══

[Sistema]: Voz pregrabada, bot, IVR automatizado. Incluye:
- IVR/menus: "para X marque Y", "si desea hablar con un agente presione..."
- Grabaciones legales: "esta llamada esta siendo grabada", "para fines de calidad"
- Bot de bienvenida: saludo automático antes de conectar con asesor
- Encuestas automaticas: "del 1 al 5 califique...", "presione 1 si..."
- Musica de espera o mensajes pregrabados
CLAVE: Voz robótica/uniforme, frases estandarizadas, no interactúa con el contenido real

Asesor: Empleado del call center. Se identifica por:
- Presenta su nombre y empresa: "le saluda [nombre] de [empresa]"
- PIDE datos al cliente: "me confirma su cédula", "a nombre de quién está"
- CONSULTA el sistema: "permítame revisar", "déjeme verificar"
- DA soluciones: "lo que vamos a hacer es...", "le voy a generar un ticket"
- USA lenguaje corporativo: "disculpe los malestares"
- PONE en espera: "permítame un momento", "me regala unos minutos"
CLAVE: Tono profesional, acceso al sistema, guía la conversación

Cliente: Persona que llama para resolver algo. Se identifica por:
- EXPLICA su problema: "no tengo internet", "me llegó una factura muy alta"
- DA sus datos personales cuando se los piden
- HACE preguntas: "¿cuándo se me va a solucionar?", "¿por qué me cobraron?"
- MUESTRA emociones: frustración, urgencia, enojo
CLAVE: Tiene el problema, da datos, hace preguntas, no tiene acceso al sistema

═══ ESTRUCTURA TÍPICA (3+ SPEAKERS) ═══
1. SPEAKER_00 suele ser [Sistema]/Bot — habla primero con mensaje automatizado
2. SPEAKER_01 suele ser Asesor — primera voz HUMANA después del bot
3. SPEAKER_02 suele ser Cliente — responde al asesor
PERO: SIEMPRE verifica por CONTENIDO, no solo por orden

═══ REGLAS DE ORO ═══
1. DEDUCCIÓN POR CONTENIDO (prioridad máxima):
   - Quien PIDE cédula/datos = Asesor
   - Quien DA sus datos personales = Cliente
   - Voz robótica/estandarizada = [Sistema]
2. NO AGRUPAR [Sistema] con Asesor — son roles DISTINTOS. El bot/IVR NO es el asesor.
3. Si hay SPEAKER_03 o más, deduce por contenido: ¿es otro asesor (transferencia)?, ¿supervisor?, ¿ruido?
4. LIMPIEZA: Elimina frases repetitivas sin sentido (alucinaciones de Whisper en silencios).
5. SILENCIOS: Convierte [Silencio detectado: Xs] en [Espera: ~Xs] entre turnos.

═══ FORMATO DE SALIDA (OBLIGATORIO) ═══
[Sistema]: texto del IVR/bot
Asesor: texto del asesor humano
Cliente: texto del cliente
[Espera: ~Xs] (si aplica)

REGLAS FINALES:
- Responde ÚNICAMENTE con la transcripción reformateada
- NO agregues introducciones, comentarios ni explicaciones
- NO inventes esperas — solo usa los [Silencio detectado: Xs] del texto
- OMITE texto incoherente o basura de transcripción
- Mantén el texto COMPLETO de cada turno — no resumas`;

async function remapWhisperXSpeakers(whisperxText, clientAIConfig) {
  if (!clientAIConfig || !clientAIConfig.ai_api_key) {
    console.log('[B2B Transcription] No AI config for speaker remapping, returning WhisperX text as-is');
    return whisperxText;
  }

  try {
    let apiKey;
    try { apiKey = decrypt(clientAIConfig.ai_api_key); } catch { apiKey = clientAIConfig.ai_api_key; }

    const openai = new OpenAI({ apiKey });
    const model = clientAIConfig.ai_model || 'gpt-4o-mini';

    // For long texts, chunk it
    const MAX_REMAP_CHARS = 14000;
    const textChunks = [];
    if (whisperxText.length <= MAX_REMAP_CHARS) {
      textChunks.push(whisperxText);
    } else {
      const lines = whisperxText.split('\n');
      let current = '';
      for (const line of lines) {
        if (current.length + line.length + 1 > MAX_REMAP_CHARS && current.length > 0) {
          textChunks.push(current);
          current = '';
        }
        current += (current ? '\n' : '') + line;
      }
      if (current) textChunks.push(current);
    }

    console.log(`[B2B Transcription] Remapping WhisperX speakers (${whisperxText.length} chars, ${textChunks.length} chunk(s))...`);

    const remappedParts = [];
    let speakerMap = ''; // Carry speaker mapping between chunks

    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      let userMessage = '';
      if (i > 0 && speakerMap) {
        userMessage += `[Mapeo de speakers ya establecido: ${speakerMap}]\n\n`;
      }
      userMessage += `${i === 0 ? 'Clasifica los hablantes en esta transcripción' : 'Continúa con la siguiente parte (mismo mapeo de speakers)'}:\n\n${chunk}`;

      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: REMAP_SPEAKERS_PROMPT },
          { role: 'user', content: userMessage }
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 8000
      });

      const result = response.choices[0].message.content;
      if (result && result.trim().length > 20) {
        remappedParts.push(result.trim());

        // Extract speaker mapping from first chunk for continuity
        if (i === 0) {
          const mappings = [];
          if (result.includes('Asesor:')) mappings.push('Asesor identificado');
          if (result.includes('Cliente:')) mappings.push('Cliente identificado');
          if (result.includes('[Sistema]:')) mappings.push('Sistema identificado');
          speakerMap = mappings.join(', ');
        }
      } else {
        remappedParts.push(chunk);
      }

      console.log(`[B2B Transcription] Speaker remap chunk ${i + 1}/${textChunks.length} complete`);
    }

    const fullRemapped = remappedParts.join('\n\n');
    console.log(`[B2B Transcription] Speaker remapping complete: ${fullRemapped.length} chars`);
    return fullRemapped;

  } catch (remapErr) {
    console.error('[B2B Transcription] Speaker remapping failed:', remapErr.message);
    return whisperxText; // Fallback: return original WhisperX text
  }
}

module.exports = {
  transcribeAudio,
  transcribeAudioFull,
  transcribeAudioFromBuffer,
  transcribeAudioFromBufferFull,
  diarizeTranscription,
  remapWhisperXSpeakers,
  resolveWhisperXCallback,
  formatVoiceMetrics,
  formatWhisperXMetrics
};
