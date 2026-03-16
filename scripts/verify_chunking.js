const { analyzeInteraction } = require('../src/services/b2bAgentService');
const { decrypt } = require('../src/utils/encryption');

// Mock AI Config
const aiConfig = {
  ai_provider: 'openai',
  ai_api_key: 'ENCRYPTED_KEY_HERE', // This will fail if not real, but we can mock createAIClient too if needed
  ai_model: 'gpt-4o'
};

// Mock createAIClient to avoid real API calls during logic test
const b2bAgentService = require('../src/services/b2bAgentService');
const originalCreateClient = b2bAgentService.createAIClient;

b2bAgentService.createAIClient = () => ({
  callAI: async (prompt, msg) => {
    console.log(`[MOCK AI] Received request. Template length in prompt approx: ${prompt.length}`);
    // Extract chunk IDs from prompt to simulate AI response
    const ids = [];
    const idRegex = /"_id":\s*(\d+)/g;
    let match;
    while ((match = idRegex.exec(prompt)) !== null) {
      ids.push(Number(match[1]));
    }
    console.log(`[MOCK AI] Evaluating IDs: ${ids.join(', ')}`);
    
    return {
      observacion_audio: "Análisis del audio...",
      criterios: ids.map(id => ({
        id,
        analisis_paso_a_paso: `Evidencia para ${id}...`,
        cumple: true,
        puntaje: 1
      })),
      resumen: "Resumen parcial",
      entregable: { campo1: "valor1" }
    };
  }
});

async function testChunking() {
  console.log("=== STARTING CHUNKING VERIFICATION ===");
  
  // Create a large template (25 criteria)
  const largeTemplate = [];
  for (let i = 1; i <= 25; i++) {
    largeTemplate.push({ _id: i, Criterio: `Criterio ${i}`, Peso: 1 });
  }

  const agent = {
    name: "Agente Test",
    evaluation_template: JSON.stringify(largeTemplate),
    description: "Agente para probar chunking"
  };

  const interaction = "Texto de la llamada...";
  
  try {
    const result = await b2bAgentService.analyzeInteraction(interaction, agent, aiConfig);
    
    console.log("\n=== RESULTS ===");
    console.log(`Total Criterios Evaluados: ${result.criterios.length}`);
    console.log(`Puntaje Total: ${result.puntaje_total} / ${result.puntaje_maximo}`);
    console.log(`Porcentaje: ${result.porcentaje}%`);
    
    const passed = result.criterios.length === 25 && result.porcentaje === 100;
    console.log(`\nVERIFICACIÓN: ${passed ? '✅ PASÓ' : '❌ FALLÓ'}`);
    
    if (result.resumen.includes("multietapa")) {
      console.log("✅ Lógica de consolidación multietapa detectada.");
    }

  } catch (error) {
    console.error("Error en test:", error);
  }
}

testChunking();
