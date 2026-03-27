const { query } = require('../src/config/database');

exports.up = async () => {
  // Insert self-hosted AI configuration into system_config
  await query(`
    INSERT INTO system_config (key, value, description) VALUES
      ('ai_provider_mode', '"external"', 'Modo IA: self-hosted, external, auto'),
      ('self_hosted_status', '{"healthy":false,"lastCheck":null}', 'Estado cached del servidor self-hosted'),
      ('self_hosted_metrics', '{"total":0,"success":0,"fallback":0,"avgLatency":0}', 'Metricas de uso IA')
    ON CONFLICT (key) DO NOTHING
  `);
  console.log('  ✓ system_config: self-hosted AI config seeds added');
};

exports.down = async () => {
  await query(`DELETE FROM system_config WHERE key IN ('ai_provider_mode', 'self_hosted_status', 'self_hosted_metrics')`);
};
