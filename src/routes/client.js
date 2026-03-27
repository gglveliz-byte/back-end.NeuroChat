const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const clientController = require('../controllers/clientController');
const { authenticate, clientOnly, emailVerified } = require('../middlewares/auth');
const { validateUpdateProfile, validateUpdateBusiness, validateChangePassword } = require('../middlewares/validation');

// Multer memoryStorage para imágenes del negocio (logo y banner) → se suben a Cloudinary
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/jpeg|jpg|png|webp/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG, PNG o WebP'));
  }
});

// Configuración de multer para subida de comprobantes (memory storage → Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Solo se permiten archivos JPG, PNG o PDF'));
  }
});

// Multer para archivos de conocimiento (PDF, TXT, CSV, Excel) - en memoria
const knowledgeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB máximo
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.pdf', '.txt', '.csv', '.xls', '.xlsx'];
    const allowedMimes = [
      'application/pdf', 'text/plain', 'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    // Aceptar si la extensión es válida (algunos SO envían mimetype genérico para CSV)
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Solo se permiten archivos PDF, TXT, CSV o Excel (.xls/.xlsx)'));
  }
});

// Todas las rutas requieren autenticación de cliente
router.use(authenticate, clientOnly);

// Dashboard
router.get('/dashboard', clientController.getDashboard);

// Perfil
router.get('/profile', clientController.getProfile);
router.put('/profile', validateUpdateProfile, clientController.updateProfile);
router.put('/password', validateChangePassword, clientController.changePassword);

// Negocio
router.get('/business', clientController.getBusiness);
router.put('/business', validateUpdateBusiness, clientController.updateBusiness);
router.post('/business/logo', imageUpload.single('image'), clientController.uploadBusinessLogo);
router.post('/business/banner', imageUpload.single('image'), clientController.uploadBusinessBanner);

// Servicios
router.get('/services', clientController.getMyServices);
router.get('/services/:code', clientController.getServiceDetail);
router.post('/services/trial', emailVerified, clientController.activateTrial);

// Pagos - endpoints originales
router.get('/payments', clientController.getMyPayments);
router.post('/payments', emailVerified, clientController.createPayment);
router.put('/payments/:paymentId/receipt', clientController.uploadReceipt);

// Pagos - nuevos endpoints
router.get('/payments/services', clientController.getServicesToPay);
router.get('/payments/history', clientController.getPaymentHistory);
router.get('/payments/bank-details', clientController.getBankDetails);
router.post('/payments/paypal/create', emailVerified, clientController.createPayPalOrder);
router.post('/payments/paypal/capture', emailVerified, clientController.capturePayPalOrder);
router.post('/payments/transfer', emailVerified, upload.single('proof'), clientController.submitTransferProof);

// Suscripción
router.get('/subscription', clientController.getSubscriptionStatus);
router.post('/services/cancel', clientController.cancelService);
router.post('/services/subscribe', emailVerified, clientController.createPendingSubscription);

// Pedidos
router.get('/orders', clientController.getMyOrders);
router.get('/orders/stats', clientController.getOrderStats);
router.put('/orders/:orderId/status', clientController.updateOrderStatus);

// Knowledge Files (globales por cliente)
router.get('/business/knowledge-files', clientController.getKnowledgeFiles);
router.post('/business/knowledge-files', knowledgeUpload.single('file'), clientController.uploadKnowledgeFile);
router.delete('/business/knowledge-files/:fileId', clientController.deleteKnowledgeFile);

// =====================================================
// BILLING / PAYG
// =====================================================
// GET /api/v1/client/billing?year=2026&month=2
router.get('/billing', clientController.getBillingDashboard);

module.exports = router;
