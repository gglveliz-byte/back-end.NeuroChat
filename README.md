# NeuroChat — Backend

Backend del sistema SaaS de ChatBots Multi-Plataforma **NeuroChat**, desarrollado por **Neuro IA S.A.S**. Construido con Node.js + Express, arquitectura de capas desacopladas (Routes → Controllers → Services).

## Tecnologías

| Componente | Tecnología | Propósito |
|---|---|---|
| **Runtime** | Node.js | Entorno asíncrono escalable |
| **Framework** | Express.js | API REST y middlewares |
| **Base de datos** | PostgreSQL + pgvector | Datos relacionales + RAG vectorial |
| **Caché / Colas** | Redis + Bull | Procesamiento asíncrono de IA pesada |
| **Real-time** | Socket.IO | Panel y bots en tiempo real |
| **Autenticación** | JWT | Sesiones seguras con expiración |
| **IA / LLM** | OpenAI GPT-4o-mini | Respuestas conversacionales + Function Calling |
| **IA trial** | Groq Llama-3.3-70b | Alternativa gratuita para plan trial |
| **Voz / Audio** | Groq Whisper + WhisperX | Transcripción y diarización de hablantes |
| **Multimedia** | FFmpeg | Normalización de audio para IA |

## Requisitos

- Node.js 18+
- npm 9+
- PostgreSQL 14+ (con extensión `pgvector`)
- Redis 6+

## Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/gglveliz-byte/back-end.NeuroChat.git
cd back-end.NeuroChat

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus valores

# 4. Ejecutar migraciones
npm run migrate

# 5. Iniciar en desarrollo
npm run dev
```

## Variables de entorno

Ver [.env.example](.env.example) para la lista completa comentada. Variables mínimas requeridas:

```env
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
ENCRYPTION_KEY=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
OPENAI_API_KEY=sk-...
FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:3001
```

## Comandos

```bash
npm run dev       # Desarrollo con nodemon
npm start         # Producción
npm run migrate   # Ejecutar migraciones de BD
npm test          # Suite de pruebas Jest
```

## Estructura

```
src/
├── app.js                  # Orquestador principal (CORS, Helmet, routers)
├── config/
│   ├── constants.js        # Límites, márgenes de billing, planes
│   ├── database.js         # Pool de conexión PostgreSQL
│   └── redis.js            # Conexión Redis
├── controllers/            # Lógica de negocio por módulo (18 archivos)
├── routes/                 # Contratos API y middlewares por ruta (11 archivos)
├── services/               # Integraciones externas y pipelines IA (24 archivos)
│   ├── openaiService.js    # GPT-4o + Function Calling
│   ├── aiProviderService.js# Selector OpenAI / Groq según plan
│   ├── embeddingService.js # RAG: indexación y búsqueda semántica
│   ├── billingService.js   # PAYG: consumo de tokens y créditos
│   ├── b2bPipelineService.js # Pipeline Audio→Transcripción→Análisis
│   └── ...
├── middlewares/            # Auth JWT, rate limiting, firma de webhooks
├── jobs/                   # CRON jobs (expiración, tokens Meta, limpieza)
├── websocket/
│   └── socketManager.js   # Salas y eventos en tiempo real
├── utils/                  # JWT helper, AES-256 encryption, hashing
migrations/                 # 37 scripts de evolución de BD
scripts/                    # Utilidades de mantenimiento y seed
tests/                      # Jest: unitarios e integración
```

## Endpoints principales

La API base es `/api/v1`.

| Módulo | Prefijo | Descripción |
|---|---|---|
| Autenticación | `/auth` | Login, registro, refresh token, reset password |
| Admin | `/admin` | Dashboard, clientes, pagos, configuración Meta |
| Cliente SaaS | `/client` | Perfil, servicios, archivos RAG, billing |
| Webhooks | `/webhook` | Meta (WA/Messenger/IG), Telegram, PayPal, WebChat |
| B2B Auditoría | `/b2b` | Pipeline de análisis de llamadas con IA |
| Agente Web | `/b2b-web` | Chatbot web con scraping + RAG |
| Voz | `/voice` | Telefonía IA con Voximplant |

## Plataformas soportadas

- WhatsApp Business API
- Messenger (Facebook)
- Instagram Direct
- Telegram
- WebChat (widget embebible)
- Bird (BSP alternativo para Meta)

## Planes y límites

| Plan | Proveedor IA | Límite diario |
|---|---|---|
| Trial | Groq (gratis) | 100 respuestas/día |
| Basic / Pro | OpenAI GPT-4o-mini | 2.000 respuestas/día |
| PAYG | OpenAI GPT-4o-mini | Sin límite (cobra por token) |

## Despliegue

Compatible con **Render** (recomendado):

1. Crear un Web Service apuntando a este repositorio
2. Build command: `npm install && npm run migrate`
3. Start command: `npm start`
4. Agregar todas las variables de entorno del `.env.example`

---

Desarrollado por **Neuro IA S.A.S** — Luis Veliz
