/**
 * B2B Web Routes
 * 
 * Routes for the Agente Web module:
 * - Admin routes (protected by admin auth middleware) 
 * - Public widget routes (no auth, identified by clientId)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, adminOnly } = require('../middlewares/auth');
const { b2bAuthenticate } = require('../middlewares/b2bAuth');
const adminController = require('../controllers/b2bWebAdminController');

const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (_req, file, cb) => {
        const allowed = ['.pdf', '.txt', '.docx', '.csv', '.md'];
        const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
        if (allowed.includes(ext)) return cb(null, true);
        cb(new Error('Formato no soportado. Usa PDF, TXT, DOCX, CSV o MD.'));
    },
});
const widgetController = require('../controllers/b2bWebWidgetController');
const {
    getDashboardStats,
    getClientConversations,
    getClientConfig,
    updateClientConfig,
    getClientConversationDetails,
    archiveConversation,
    deleteConversation
} = require('../controllers/b2bWebClientController');

// ─── Admin Routes (protected: authenticate + adminOnly) ────────
// Base path: /api/v1/b2b-web/admin/clients/:clientId/web-config

// Web Config
router.get('/admin/clients/:clientId/web-config', authenticate, adminOnly, adminController.getWebConfig);
router.put('/admin/clients/:clientId/web-config', authenticate, adminOnly, adminController.updateWebConfig);

// Scrape URLs
router.get('/admin/clients/:clientId/web-config/scrape-urls', authenticate, adminOnly, adminController.listScrapeUrls);
router.post('/admin/clients/:clientId/web-config/scrape-urls', authenticate, adminOnly, adminController.addScrapeUrl);
router.delete('/admin/clients/:clientId/web-config/scrape-urls/:urlId', authenticate, adminOnly, adminController.deleteScrapeUrl);
router.post('/admin/clients/:clientId/web-config/scrape-urls/:urlId/scrape', authenticate, adminOnly, adminController.triggerScrape);
router.post('/admin/clients/:clientId/web-config/scrape-urls/:urlId/scrape-agent', authenticate, adminOnly, adminController.triggerAgenticScrape);

// Uploaded Files (Knowledge Base)
router.get('/admin/clients/:clientId/web-config/uploaded-files', authenticate, adminOnly, adminController.listUploadedFiles);
router.post('/admin/clients/:clientId/web-config/uploaded-files', authenticate, adminOnly, fileUpload.single('file'), adminController.uploadFile);
router.delete('/admin/clients/:clientId/web-config/uploaded-files/:fileId', authenticate, adminOnly, adminController.deleteUploadedFile);

// OAuth
router.get('/admin/clients/:clientId/web-config/oauth', authenticate, adminOnly, adminController.getOAuth);
router.put('/admin/clients/:clientId/web-config/oauth', authenticate, adminOnly, adminController.updateOAuth);
router.post('/admin/clients/:clientId/web-config/oauth/test', authenticate, adminOnly, adminController.testOAuth);

// API Endpoints
router.get('/admin/clients/:clientId/web-config/api-endpoints', authenticate, adminOnly, adminController.listApiEndpoints);
router.post('/admin/clients/:clientId/web-config/api-endpoints', authenticate, adminOnly, adminController.upsertApiEndpoint);
router.delete('/admin/clients/:clientId/web-config/api-endpoints/:endpointId', authenticate, adminOnly, adminController.deleteApiEndpoint);

// Conversations
router.get('/admin/clients/:clientId/web-config/conversations', authenticate, adminOnly, adminController.listConversations);
router.get('/admin/clients/:clientId/web-config/conversations/:convId', authenticate, adminOnly, adminController.getConversation);

// ─── Web Client Routes (b2bAuthenticate) ───────────────────────
// Base path: /api/v1/b2b-web/client

// --- Client Dashboard (Agente Web) Endpoints ---
router.get('/client/stats', b2bAuthenticate, getDashboardStats);
router.get('/client/conversations', b2bAuthenticate, getClientConversations);
router.get('/client/conversations/:convId', b2bAuthenticate, getClientConversationDetails);
router.put('/client/conversations/:convId/archive', b2bAuthenticate, archiveConversation);
router.delete('/client/conversations/:convId', b2bAuthenticate, deleteConversation);
router.get('/client/config', b2bAuthenticate, getClientConfig);
router.put('/client/config', b2bAuthenticate, updateClientConfig);

// ─── Public Widget Routes ──────────────────────────────────────
// No auth required — used by the embedded chat widget
// Base path: /api/v1/b2b-web/widget

router.get('/widget/:clientId/config', widgetController.getWidgetConfig);
router.post('/widget/:clientId/conversations', widgetController.startConversation);
router.post('/widget/:clientId/conversations/:convId/messages', widgetController.sendMessage);
router.get('/widget/:clientId/conversations/:convId/messages', widgetController.getMessages);
router.post('/widget/:clientId/conversations/:convId/location', widgetController.saveLocation);

module.exports = router;
