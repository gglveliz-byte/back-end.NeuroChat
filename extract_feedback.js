require('dotenv').config();
const { query } = require('./src/config/database');

(async () => {
  try {
    const agents = await query('SELECT name, description, feedback_accumulated FROM b2b_agents WHERE feedback_accumulated IS NOT NULL AND feedback_accumulated != \'\'');
    console.log("=== AGENT FEEDBACK ACCUMULATED ===");
    if (agents.rows.length === 0) console.log("No hay feedback acumulado en b2b_agents.");
    
    agents.rows.forEach(r => {
      console.log(`\n🤖 Agente: ${r.name}`);
      console.log(`📝 Feedback:\n${r.feedback_accumulated}`);
      console.log('--------------------------------------------------');
    });

    const patterns = await query(`
      SELECT
        correction->>'nombre' as criterio,
        COUNT(DISTINCT eh.audio_hash) as audios_corregidos,
        SUM(CASE WHEN (correction->>'cumple')::boolean THEN 1 ELSE 0 END)::int as veces_cumple,
        SUM(CASE WHEN NOT (correction->>'cumple')::boolean THEN 1 ELSE 0 END)::int as veces_no_cumple
      FROM b2b_evaluation_history eh,
        jsonb_array_elements(human_corrections) as correction
      WHERE correction->>'nombre' IS NOT NULL
      GROUP BY correction->>'nombre'
      ORDER BY audios_corregidos DESC
      LIMIT 15
    `);

    console.log("\n=== PATRONES DE CORRECCIÓN (Más de un audio) ===");
    if (patterns.rows.length === 0) console.log("No hay patrones de corrección guardados.");
    patterns.rows.forEach(r => {
      console.log(`🔴 Criterio: "${r.criterio}"`);
      console.log(`   Audios corregidos: ${r.audios_corregidos} | Tendencia: CUMPLE(${r.veces_cumple}) vs NO CUMPLE(${r.veces_no_cumple})`);
    });

  } catch (e) {
    console.error("Error consultando BD:", e.message);
  }
  process.exit();
})();
