const express = require('express');
const router = express.Router();
const multer = require('multer');

// Multer config for Excel template uploads
const templateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const ext = file.originalname.toLowerCase();
        if (ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls) o CSV (.csv)'));
        }
    }
});

// Multer config for audio uploads — supports long calls (15+ min, up to ~100MB raw)
// ffmpeg converts to 64k mono mp3 before Whisper, so even 60min audio fits under 25MB
const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max raw upload
    fileFilter: (req, file, cb) => {
        // Accept any audio format — ffmpeg will convert
        const mimeOk = file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream';
        const extOk = /\.(mp3|wav|ogg|m4a|mp4|webm|flac|opus|aac|amr|gsm|3gp|wma|aiff|mpeg)$/i.test(file.originalname);
        if (mimeOk || extOk) {
            cb(null, true);
        } else {
            cb(new Error('Formato de audio no soportado. Formatos aceptados: MP3, WAV, OGG, M4A, FLAC, AAC, AMR, GSM, WMA, AIFF, 3GP'));
        }
    }
});

// Middlewares
const { authenticate, adminOnly } = require('../middlewares/auth');
const { b2bAuthenticate } = require('../middlewares/b2bAuth');
const { authLimiter } = require('../middlewares/rateLimiter');

// Controllers
const b2bAdminController = require('../controllers/b2bAdminController');
const b2bClientController = require('../controllers/b2bClientController');
const b2bWebhookController = require('../controllers/b2bWebhookController');

// Multer config for text/document uploads (PDF, TXT, EML, HTML)
const textUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (req, file, cb) => {
        const extOk = /\.(pdf|txt|eml|html|htm|csv|doc|docx|msg)$/i.test(file.originalname);
        const mimeOk = [
            'application/pdf', 'text/plain', 'text/html', 'message/rfc822',
            'text/csv', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ].includes(file.mimetype);
        if (extOk || mimeOk) {
            cb(null, true);
        } else {
            cb(new Error('Formato no soportado. Formatos aceptados: PDF, TXT, EML, HTML, CSV, DOC, DOCX'));
        }
    }
});

// ─── Webhooks de Ingesta (public — authenticated by clientId in URL) ────
router.post('/webhook/:clientId/call', b2bWebhookController.receiveCall);
router.post('/webhook/:clientId/email', b2bWebhookController.receiveEmail);

// ─── WhisperX async callback (public — authenticated by API key in body) ────
const { resolveWhisperXCallback } = require('../services/b2bTranscriptionService');
router.post('/whisperx-callback', (req, res) => {
  const { interaction_id, api_key, ...data } = req.body;

  // Verify API key
  const expectedKey = process.env.WHISPERX_API_KEY || 'whisperx-secret-key-change-me';
  if (api_key !== expectedKey) {
    console.error('[WhisperX Callback] Invalid API key');
    return res.status(403).json({ error: 'Invalid API key' });
  }

  if (!interaction_id) {
    return res.status(400).json({ error: 'Missing interaction_id' });
  }

  console.log(`[WhisperX Callback] Received result for interaction ${interaction_id}`);
  resolveWhisperXCallback(interaction_id, data);
  res.json({ received: true });
});

// ─── Auth B2B ───────────────────────────────────────────────────────────
router.post('/auth/login', authLimiter, b2bClientController.login);

// ─── Admin (authenticate + adminOnly) ───────────────────────────────────
router.get('/admin/clients', authenticate, adminOnly, b2bAdminController.listClients);
router.get('/admin/clients/:clientId/token-usage', authenticate, adminOnly, b2bAdminController.getTokenUsage);
router.post('/admin/clients', authenticate, adminOnly, b2bAdminController.createClient);
router.get('/admin/clients/:clientId', authenticate, adminOnly, b2bAdminController.getClient);
router.put('/admin/clients/:clientId', authenticate, adminOnly, b2bAdminController.updateClient);
router.post('/admin/pull-detect', authenticate, adminOnly, b2bAdminController.detectPullFields);
router.get('/admin/clients/:clientId/areas', authenticate, adminOnly, b2bAdminController.listAreas);
router.post('/admin/clients/:clientId/areas', authenticate, adminOnly, b2bAdminController.createArea);
router.get('/admin/areas/:areaId/agents', authenticate, adminOnly, b2bAdminController.listAgents);
router.post('/admin/areas/:areaId/agents', authenticate, adminOnly, b2bAdminController.createAgent);
router.put('/admin/agents/:agentId/prompt', authenticate, adminOnly, b2bAdminController.updatePrompt);
router.post('/admin/agents/:agentId/generate-prompt', authenticate, adminOnly, b2bAdminController.generatePrompt);
router.delete('/admin/agents/:agentId', authenticate, adminOnly, b2bAdminController.deleteAgent);

// Convenience endpoints for v2 multi-layer prompt system
router.put('/admin/agents/:agentId/description', authenticate, adminOnly, b2bAdminController.updatePrompt);
router.put('/admin/agents/:agentId/evaluation', authenticate, adminOnly, b2bAdminController.updatePrompt);
router.put('/admin/agents/:agentId/deliverable', authenticate, adminOnly, b2bAdminController.updatePrompt);
router.put('/admin/agents/:agentId/feedback', authenticate, adminOnly, b2bAdminController.updatePrompt);
// Excel template upload (admin)
router.post('/admin/agents/:agentId/upload-template', authenticate, adminOnly, templateUpload.single('file'), b2bAdminController.uploadTemplate);
// Criteria CRUD (admin)
router.post('/admin/agents/:agentId/criteria', authenticate, adminOnly, b2bAdminController.addCriterion);
router.put('/admin/agents/:agentId/criteria/:criterionId', authenticate, adminOnly, b2bAdminController.updateCriterion);
router.delete('/admin/agents/:agentId/criteria/:criterionId', authenticate, adminOnly, b2bAdminController.deleteCriterion);

// ─── Panel Cliente B2B (b2bAuthenticate) ────────────────────────────────
router.get('/areas', b2bAuthenticate, b2bClientController.getAreas);
router.put('/areas/:areaId/processing-mode', b2bAuthenticate, b2bClientController.updateProcessingMode);

// Agents management (client can configure their own agents)
router.get('/areas/:areaId/agents', b2bAuthenticate, b2bAdminController.listAgents);
router.post('/areas/:areaId/agents', b2bAuthenticate, b2bAdminController.createAgent);
router.put('/agents/:agentId/prompt', b2bAuthenticate, b2bAdminController.updatePrompt);
router.post('/agents/:agentId/generate-prompt', b2bAuthenticate, b2bAdminController.generatePrompt);
router.delete('/agents/:agentId', b2bAuthenticate, b2bAdminController.deleteAgent);

// Convenience endpoints for v2 multi-layer prompt system (client access)
router.put('/agents/:agentId/description', b2bAuthenticate, b2bAdminController.updatePrompt);
router.put('/agents/:agentId/evaluation', b2bAuthenticate, b2bAdminController.updatePrompt);
router.put('/agents/:agentId/deliverable', b2bAuthenticate, b2bAdminController.updatePrompt);
router.put('/agents/:agentId/feedback', b2bAuthenticate, b2bAdminController.updatePrompt);
// Excel template upload (client)
router.post('/agents/:agentId/upload-template', b2bAuthenticate, templateUpload.single('file'), b2bAdminController.uploadTemplate);
// Criteria CRUD (client)
router.post('/agents/:agentId/criteria', b2bAuthenticate, b2bAdminController.addCriterion);
router.put('/agents/:agentId/criteria/:criterionId', b2bAuthenticate, b2bAdminController.updateCriterion);
router.delete('/agents/:agentId/criteria/:criterionId', b2bAuthenticate, b2bAdminController.deleteCriterion);

// Interactions, review, export
router.get('/interactions', b2bAuthenticate, b2bClientController.listInteractions);
router.get('/interactions/:id', b2bAuthenticate, b2bClientController.getInteraction);
router.post('/interactions/:id/selective-reprocess', b2bAuthenticate, b2bClientController.selectiveReprocess);
router.put('/interactions/:id/reassign-agent', b2bAuthenticate, b2bClientController.reassignAgent);
router.delete('/interactions/:id', b2bAuthenticate, b2bClientController.deleteInteraction);
router.delete('/interactions', b2bAuthenticate, b2bClientController.deleteAllInteractions);
router.get('/review/queue', b2bAuthenticate, b2bClientController.getReviewQueue);
router.post('/review/:id/approve', b2bAuthenticate, b2bClientController.approveReview);
router.post('/review/:id/reject', b2bAuthenticate, b2bClientController.rejectReview);
router.post('/export', b2bAuthenticate, b2bClientController.createExport);
router.get('/export/:exportId', b2bAuthenticate, b2bClientController.downloadExport);
// Agent memory management
router.delete('/agents/:agentId/feedback', b2bAuthenticate, b2bClientController.clearFeedback);
// Audio upload — long timeout for large call recordings (15+ min audio)
router.post('/upload-audio', b2bAuthenticate, (req, res, next) => {
    req.setTimeout(600000); // 10 min timeout for full pipeline (transcribe + diarize + filter + analyze)
    res.setTimeout(600000);
    next();
}, audioUpload.single('audio'), b2bClientController.uploadAudio);
// Text/document upload — skips transcription, goes straight to filter
router.post('/upload-text', b2bAuthenticate, textUpload.single('file'), b2bClientController.uploadText);

module.exports = router;
