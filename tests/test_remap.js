const fs = require('fs');
const { OpenAI } = require('openai');
require('dotenv').config();

const d = require('../whisper_result.json');
const rawText = d.segments.map(s => s.speaker + ': ' + s.text).join('\n');

const REMAP_SPEAKERS_PROMPT = `Eres un clasificador de hablantes en llamadas de call center (Ecuador/Latinoamérica).

Recibes una transcripción ya diarizada con etiquetas SPEAKER_00, SPEAKER_01, etc.
Tu ÚNICA tarea: reemplazar cada SPEAKER_XX con el rol correcto.

ROLES:
- [Sistema]: IVR, grabaciones automáticas, menús ("para X marque Y", "esta llamada será grabada")
- Asesor: Empleado que saluda con nombre/empresa, pide datos, consulta sistema, da soluciones
- Cliente: Persona que llama, explica su problema, da sus datos, hace preguntas, muestra emociones

REGLAS:
- Si hay MÁS DE DOS humanos detectados (ej. SPEAKER_02, SPEAKER_03), DEDUCE si son la misma persona o si hay ruido. Agrúpalos lógicamente bajo "Cliente" o "Asesor".
- Después del IVR, la PRIMERA voz humana = Asesor (presenta nombre/empresa)
- La SEGUNDA voz humana = Cliente (saluda y explica su problema)
- Quien PIDE cédula/datos = Asesor | Quien DA sus datos = Cliente
- Quien consulta sistema/genera tickets = Asesor | Quien tiene el problema = Cliente
- [Silencio detectado: Xs] → convertir a [Espera: ~Xs]
- Mantén el texto COMPLETO de cada turno — no resumas ni omitas
- Responde SOLO con la transcripción reformateada, sin comentarios`;

async function testRemap() {
  console.log('Sending to OpenAI...');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: REMAP_SPEAKERS_PROMPT },
      { role: 'user', content: 'Clasifica los hablantes en esta transcripción:\n\n' + rawText }
    ],
    temperature: 0.05
  });
  console.log('\n=== REMAPPED TRANSCRIPT ===\n');
  console.log(response.choices[0].message.content);
}

testRemap().catch(console.error);
