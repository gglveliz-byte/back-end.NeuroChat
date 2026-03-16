require('dotenv').config();
const { query, pool } = require('../src/config/database');

console.log('\n');
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║                                                            ║');
console.log('║   🔍 Pre-Deploy Verification Script                        ║');
console.log('║   ────────────────────────────────                         ║');
console.log('║   Verificando sistema antes de producción...               ║');
console.log('║                                                            ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('\n');

let hasErrors = false;
let hasWarnings = false;

// Helper para logs
const success = (msg) => console.log(`✅ ${msg}`);
const error = (msg) => { console.log(`❌ ${msg}`); hasErrors = true; };
const warning = (msg) => { console.log(`⚠️  ${msg}`); hasWarnings = true; };
const info = (msg) => console.log(`ℹ️  ${msg}`);

async function runChecks() {
  try {
    // ============================================
    // 1. VERIFICAR VARIABLES DE ENTORNO
    // ============================================
    console.log('📋 1. Verificando Variables de Entorno...\n');

    // Database
    if (process.env.DATABASE_URL) {
      success('DATABASE_URL configurada');
    } else {
      error('DATABASE_URL no configurada');
    }

    // OpenAI (CRÍTICO)
    if (process.env.OPENAI_API_KEY) {
      success('OPENAI_API_KEY configurada');
    } else {
      error('OPENAI_API_KEY no configurada (CRÍTICO - el bot no funcionará)');
    }

    // Frontend URL
    if (process.env.FRONTEND_URL) {
      success(`FRONTEND_URL: ${process.env.FRONTEND_URL}`);
    } else {
      warning('FRONTEND_URL no configurada (se usará http://localhost:3000)');
    }

    // SMTP (opcional pero recomendado)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      success('SMTP configurado - Emails funcionarán');
    } else {
      warning('SMTP no configurado - Los emails de límite alcanzado NO se enviarán');
      info('   Para habilitar: configura SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS');
    }

    // Admin credentials
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      success(`Admin configurado: ${process.env.ADMIN_EMAIL}`);
    } else {
      warning('Credenciales de admin no configuradas en .env');
    }

    // Telegram (opcional)
    if (process.env.TELEGRAM_BOT_TOKEN) {
      success('Telegram bot token configurado');
    } else {
      info('Telegram bot token no configurado (opcional)');
    }

    console.log('\n');

    // ============================================
    // 2. VERIFICAR CONEXIÓN A BASE DE DATOS
    // ============================================
    console.log('🗄️  2. Verificando Conexión a Base de Datos...\n');

    try {
      const result = await query('SELECT NOW() as now');
      success(`Conectado a PostgreSQL - ${result.rows[0].now}`);

      // Verificar esquema
      const schemaResult = await query("SELECT current_schema()");
      const schema = schemaResult.rows[0].current_schema;
      if (schema === 'chatbot_saas') {
        success(`Esquema correcto: ${schema}`);
      } else {
        warning(`Esquema actual: ${schema} (esperado: chatbot_saas)`);
      }
    } catch (err) {
      error(`No se puede conectar a la base de datos: ${err.message}`);
    }

    console.log('\n');

    // ============================================
    // 3. VERIFICAR MIGRACIONES
    // ============================================
    console.log('📦 3. Verificando Migraciones...\n');

    try {
      const migrations = await query('SELECT name, executed_at FROM migrations ORDER BY executed_at');
      if (migrations.rows.length > 0) {
        success(`${migrations.rows.length} migraciones ejecutadas:`);
        migrations.rows.forEach((m, i) => {
          console.log(`   ${i + 1}. ${m.name}`);
        });

        // Verificar migraciones críticas de límites
        const migrationNames = migrations.rows.map(m => m.name);
        if (migrationNames.includes('007_add_message_usage_tracking.js')) {
          success('Migration 007 (message_usage) ejecutada ✓');
        } else {
          error('Migration 007 (message_usage) NO ejecutada - Sistema de límites no funcionará');
        }

        if (migrationNames.includes('008_add_conversation_message_tracking.js')) {
          success('Migration 008 (conversation_message_usage) ejecutada ✓');
        } else {
          error('Migration 008 (conversation_message_usage) NO ejecutada - Límite por conversación no funcionará');
        }
      } else {
        warning('No hay migraciones ejecutadas - ejecuta: node migrations/run.js');
      }
    } catch (err) {
      error(`Error verificando migraciones: ${err.message}`);
    }

    console.log('\n');

    // ============================================
    // 4. VERIFICAR TABLAS CRÍTICAS
    // ============================================
    console.log('🗃️  4. Verificando Tablas Críticas...\n');

    const criticalTables = [
      'clients',
      'services',
      'client_services',
      'conversations',
      'messages',
      'bot_configs',
      'message_usage',
      'conversation_message_usage',
      'client_knowledge_files'
    ];

    for (const table of criticalTables) {
      try {
        const result = await query(`SELECT COUNT(*) as count FROM ${table}`);
        success(`Tabla '${table}' existe (${result.rows[0].count} registros)`);
      } catch (err) {
        error(`Tabla '${table}' NO existe o no accesible`);
      }
    }

    console.log('\n');

    // ============================================
    // 5. VERIFICAR SERVICIOS DISPONIBLES
    // ============================================
    console.log('🚀 5. Verificando Servicios Disponibles...\n');

    try {
      const services = await query('SELECT name, code, price_monthly, is_active FROM services ORDER BY name');
      if (services.rows.length > 0) {
        success(`${services.rows.length} servicios configurados:`);
        services.rows.forEach(s => {
          const status = s.is_active ? '✓ Activo' : '✗ Inactivo';
          console.log(`   - ${s.name} (${s.code}): $${s.price_monthly}/mes [${status}]`);
        });
      } else {
        warning('No hay servicios configurados - ejecuta: node scripts/seed-services.js');
      }
    } catch (err) {
      error(`Error verificando servicios: ${err.message}`);
    }

    console.log('\n');

    // ============================================
    // 6. VERIFICAR CONSTANTES DEL SISTEMA
    // ============================================
    console.log('⚙️  6. Verificando Constantes del Sistema...\n');

    try {
      const constants = require('../src/config/constants');

      if (constants.TRIAL && constants.TRIAL.MAX_MESSAGES_PER_DAY === 100) {
        success(`Límite Trial: ${constants.TRIAL.MAX_MESSAGES_PER_DAY} mensajes/día ✓`);
      } else {
        error('Constante TRIAL.MAX_MESSAGES_PER_DAY incorrecta o no configurada');
      }

      if (constants.PAID && constants.PAID.MAX_MESSAGES_PER_DAY === 2000) {
        success(`Límite Premium: ${constants.PAID.MAX_MESSAGES_PER_DAY} mensajes/día ✓`);
      } else {
        error('Constante PAID.MAX_MESSAGES_PER_DAY incorrecta o no configurada');
      }

      if (constants.CONVERSATION_LIMITS && constants.CONVERSATION_LIMITS.MAX_MESSAGES_PER_DAY === 50) {
        success(`Límite por Conversación: ${constants.CONVERSATION_LIMITS.MAX_MESSAGES_PER_DAY} mensajes/día ✓`);
      } else {
        error('Constante CONVERSATION_LIMITS.MAX_MESSAGES_PER_DAY incorrecta o no configurada');
      }
    } catch (err) {
      error(`Error cargando constantes: ${err.message}`);
    }

    console.log('\n');

    // ============================================
    // 7. VERIFICAR SERVICIOS DE BACKEND
    // ============================================
    console.log('🔧 7. Verificando Servicios de Backend...\n');

    try {
      const messageLimitService = require('../src/services/messageLimitService');
      const requiredFunctions = [
        'checkMessageLimit',
        'incrementMessageCount',
        'checkConversationLimit',
        'incrementConversationCount'
      ];

      const hasAllFunctions = requiredFunctions.every(fn => typeof messageLimitService[fn] === 'function');
      if (hasAllFunctions) {
        success('messageLimitService cargado correctamente');
      } else {
        error('messageLimitService no tiene todas las funciones requeridas');
      }
    } catch (err) {
      error(`Error cargando messageLimitService: ${err.message}`);
    }

    try {
      const emailService = require('../src/services/emailService');
      if (typeof emailService.sendDailyLimitReachedEmail === 'function') {
        success('emailService cargado correctamente');
      } else {
        error('emailService.sendDailyLimitReachedEmail no encontrada');
      }
    } catch (err) {
      error(`Error cargando emailService: ${err.message}`);
    }

    console.log('\n');

    // ============================================
    // 8. VERIFICAR CONFIGURACIÓN DE OPENAI
    // ============================================
    console.log('🤖 8. Verificando OpenAI...\n');

    if (process.env.OPENAI_API_KEY) {
      try {
        const openaiService = require('../src/services/openaiService');
        success('openaiService cargado correctamente');
        info('   Modelo configurado: gpt-4o-mini');
      } catch (err) {
        error(`Error cargando openaiService: ${err.message}`);
      }
    } else {
      error('OPENAI_API_KEY no configurada - El bot NO podrá generar respuestas');
    }

    console.log('\n');

    // ============================================
    // RESUMEN FINAL
    // ============================================
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('📊 RESUMEN DE VERIFICACIÓN:');
    console.log('');

    if (!hasErrors && !hasWarnings) {
      console.log('✅ ¡TODO PERFECTO! Sistema listo para producción 🚀');
      console.log('');
      console.log('Siguiente paso:');
      console.log('  1. Reinicia el backend: npm start');
      console.log('  2. Verifica que el frontend esté conectado');
      console.log('  3. ¡Deploy a producción!');
    } else if (!hasErrors && hasWarnings) {
      console.log('⚠️  Sistema funcional pero con advertencias');
      console.log('');
      console.log('Puedes deployar a producción, pero considera:');
      console.log('  - Configurar SMTP para emails automáticos');
      console.log('  - Revisar las advertencias arriba');
    } else {
      console.log('❌ ERRORES ENCONTRADOS - NO DEPLOYAR A PRODUCCIÓN');
      console.log('');
      console.log('Acciones requeridas:');
      console.log('  1. Corrige los errores marcados con ❌');
      console.log('  2. Ejecuta este script nuevamente');
      console.log('  3. Cuando no haya errores, procede al deploy');
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n');

    process.exit(hasErrors ? 1 : 0);

  } catch (error) {
    console.error('\n❌ Error fatal durante verificación:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runChecks();
