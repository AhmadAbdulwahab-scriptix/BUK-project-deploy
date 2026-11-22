const express = require('express');
const router = express.Router();
const { handleFlutterwaveWebhook } = require('../controllers/webhook.controller');

// Raw bytes are required so the HMAC is calculated over exactly what Flutterwave signed.
router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), handleFlutterwaveWebhook);

module.exports = router;
