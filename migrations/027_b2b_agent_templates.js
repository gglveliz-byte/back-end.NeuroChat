const { query } = require('../src/config/database');

exports.up = async () => {
  // ─── Add template columns to b2b_agents ───────────────────────
  // Replaces single system_prompt with 4-layer editable system:
  //   description          → what this agent does (Layer 2)
  //   evaluation_template  → criteria to evaluate (Layer 3)
  //   deliverable_template → output format (Layer 4)
  //   feedback_accumulated → improvements from rejections (Layer 5)
  // Layer 1 (fixed prompt) lives in code, not DB.
  // system_prompt kept for backward compatibility.

  await query(`ALTER TABLE b2b_agents ADD COLUMN IF NOT EXISTS description TEXT`);
  console.log('  ✓ b2b_agents.description');

  await query(`ALTER TABLE b2b_agents ADD COLUMN IF NOT EXISTS evaluation_template TEXT`);
  console.log('  ✓ b2b_agents.evaluation_template');

  await query(`ALTER TABLE b2b_agents ADD COLUMN IF NOT EXISTS deliverable_template TEXT`);
  console.log('  ✓ b2b_agents.deliverable_template');

  await query(`ALTER TABLE b2b_agents ADD COLUMN IF NOT EXISTS feedback_accumulated TEXT DEFAULT ''`);
  console.log('  ✓ b2b_agents.feedback_accumulated');

  // ─── Add audio_url to b2b_interactions ────────────────────────
  // Audio must persist so specialized agents can access it later.
  await query(`ALTER TABLE b2b_interactions ADD COLUMN IF NOT EXISTS audio_url TEXT`);
  console.log('  ✓ b2b_interactions.audio_url');
};
