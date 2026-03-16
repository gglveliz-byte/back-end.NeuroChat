const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middlewares/auth');
const { authLimiter, registerLimiter, forgotPasswordLimiter } = require('../middlewares/rateLimiter');
const {
  validateLogin,
  validateRegister,
  validateVerifyEmail,
  validateForgotPassword,
  validateResetPassword
} = require('../middlewares/validation');

// Rutas públicas (con validación)
router.post('/login', authLimiter, validateLogin, authController.login);
router.post('/register', registerLimiter, validateRegister, authController.register);
router.post('/verify-email', validateVerifyEmail, authController.verifyEmail);
router.post('/resend-verification', authLimiter, authController.resendVerification);
router.post('/forgot-password', forgotPasswordLimiter, validateForgotPassword, authController.forgotPassword);
router.post('/reset-password', validateResetPassword, authController.resetPassword);
router.post('/refresh', authController.refreshAccessToken);

// Rutas protegidas
router.post('/logout', authenticate, authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);
router.get('/me', authenticate, authController.getMe);

module.exports = router;
