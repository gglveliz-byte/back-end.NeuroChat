const { query } = require('../src/config/database');

exports.up = async () => {
  // Add multi-agent config to specialized agents
  await query(`
    ALTER TABLE b2b_agents
    ADD COLUMN IF NOT EXISTS multi_agent_enabled BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS multi_agent_config JSONB DEFAULT NULL
  `);
  console.log('  ✓ b2b_agents: multi_agent_enabled + multi_agent_config columns added');

  // Add agent_results array to interactions (stores per-agent evaluations)
  await query(`
    ALTER TABLE b2b_interactions
    ADD COLUMN IF NOT EXISTS agent_results JSONB DEFAULT NULL
  `);
  console.log('  ✓ b2b_interactions: agent_results column added');

  // Add agent_results to evaluation history cache
  await query(`
    ALTER TABLE b2b_evaluation_history
    ADD COLUMN IF NOT EXISTS agent_results JSONB DEFAULT NULL
  `);
  console.log('  ✓ b2b_evaluation_history: agent_results column added');
};

exports.down = async () => {
  await query(`ALTER TABLE b2b_agents DROP COLUMN IF EXISTS multi_agent_enabled, DROP COLUMN IF EXISTS multi_agent_config`);
  await query(`ALTER TABLE b2b_interactions DROP COLUMN IF EXISTS agent_results`);
  await query(`ALTER TABLE b2b_evaluation_history DROP COLUMN IF EXISTS agent_results`);
};
