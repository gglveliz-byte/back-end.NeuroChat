const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

async function testWhisper() {
  const filePath = 'C:\\Users\\lveli\\OneDrive\\Escritorio\\chats bots\\CI 1716798697 CTA 102399581 IMEZA.MP3';
  const url = 'http://localhost:8765/transcribe';
  
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    return;
  }

  console.log('Sending file to WhisperX:', filePath);
  console.log('Endpoint:', url);

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));

  try {
    const response = await axios.post(url, formData, {
      headers: {
        ...formData.getHeaders(),
        // Add the default API key from the service
        'Authorization': `Bearer whisperx-secret-key-change-me`
      },
      timeout: 600000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log('\n=== WHISPERX RESPONSE ===\n');
    console.log(response.data.transcript.substring(0, 1500));
    console.log('\n... (truncated if too long)');
  } catch (err) {
    console.error('Error calling WhisperX:', err.message);
    if (err.response) {
      console.error('Data:', err.response.data);
    }
  }
}

testWhisper();
