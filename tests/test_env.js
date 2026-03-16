require('dotenv').config();
console.log('WHISPERX_URL:', process.env.WHISPERX_URL);
console.log('WHISPERX_API_KEY:', process.env.WHISPERX_API_KEY);
console.log('Comparison with expected:', process.env.WHISPERX_API_KEY === 'wxk-neurochat-2026-prod-secure');
