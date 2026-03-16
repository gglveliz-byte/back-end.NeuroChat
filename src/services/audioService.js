/**
 * audioService.js
 * Transcripción de audios con OpenAI Whisper
 * Soporta: WhatsApp (OGG), Telegram (OGG), Messenger (MP3/M4A), Instagram
 */
const OpenAI = require('openai');
const axios = require('axios');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIME_TO_EXT = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/opus': 'ogg',
};

/**
 * Transcribe un Buffer de audio con OpenAI Whisper.
 * @returns {string} Texto transcripto
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg', language = 'es') {
  const ext = MIME_TO_EXT[mimeType] || 'ogg';

  const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType });

  const result = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language,
    response_format: 'text',
  });

  return typeof result === 'string' ? result.trim() : result?.text?.trim() || '';
}

/**
 * Descarga audio de Telegram (voice/audio) via Bot API.
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
async function downloadTelegramAudio(fileId, botToken) {
  const fileInfoRes = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  );
  const filePath = fileInfoRes.data?.result?.file_path;
  if (!filePath) throw new Error('Telegram: no se obtuvo ruta del archivo de audio');

  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const audioRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });

  return {
    buffer: Buffer.from(audioRes.data),
    mimeType: 'audio/ogg',
  };
}

/**
 * Descarga audio desde URL directa (Messenger, Instagram).
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
async function downloadAudioFromUrl(url, accessToken = null) {
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const res = await axios.get(url, { responseType: 'arraybuffer', headers });
  return {
    buffer: Buffer.from(res.data),
    mimeType: res.headers['content-type']?.split(';')[0] || 'audio/mpeg',
  };
}

module.exports = { transcribeAudio, downloadTelegramAudio, downloadAudioFromUrl };
