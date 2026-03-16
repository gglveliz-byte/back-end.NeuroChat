const express = require('express');
const router = express.Router();
const storeController = require('../controllers/storeController');

// Rutas públicas de la tienda
router.get('/:slug', storeController.getStoreBySlug);

module.exports = router;
