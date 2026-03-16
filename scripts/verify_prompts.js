const { buildFullPromptV2 } = require('../src/services/b2bAgentService');

// Mock agent with the new v2 structure
const mockAgent = {
  name: "Auditor de Pagos",
  description: "Evaluar la gestión de cobros y pagos según el protocolo de la empresa.",
  evaluation_template: JSON.stringify([
    { _id: 1, Criterio: "Saludo Inicial", Descripcion: "El asesor debe saludar con nombre y empresa.", Peso: 0.4 },
    { _id: 2, Criterio: "Gestión de Pago", Descripcion: "El asesor debe solicitar el envío del comprobante.", Peso: 0.6 }
  ]),
  deliverable_template: "Incluye un campo 'recomendacion_coach' para el supervisor.",
  feedback_accumulated: "El asesor tiende a olvidar pedir el nombre de la empresa, ser estricto con esto."
};

console.log("=== COMPOSING PROMPT V2 ===");
const fullPrompt = buildFullPromptV2(mockAgent);
console.log(fullPrompt);

console.log("\n=== VERIFICATION CHECKS ===");
const checks = [
  { name: "Senior Auditor Persona", regex: /Auditor Senior de Calidad/ },
  { name: "Reasoning First Instruction", regex: /RAZONAMIENTO PRIMERO/ },
  { name: "Flexibility Instruction", regex: /FLEXIBILIDAD INTELIGENTE/ },
  { name: "Chain of Thought in Template", regex: /analisis_paso_a_paso/ },
  { name: "Deliverable Template Included", regex: /recomendacion_coach/ }
];

checks.forEach(check => {
  const passed = check.regex.test(fullPrompt);
  console.log(`${passed ? '✅' : '❌'} ${check.name}`);
});
