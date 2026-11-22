const config = require('../config');
const db = require('../config/database');
const webhookService = require('../services/webhook.service');
const { verifyFlutterwaveWebhook } = require('../helpers/payments');
const logger = require('../utils/logger');

/**
 * Flutterwave wants a fast 200. We verify the signature, SAVE the event, answer 200, and only then
 * do the slow part (calling Flutterwave to verify) in the background. If that fails, the saved
 * receipt is retried by the webhook sweep, so acknowledging early loses nothing.
 */
async function handleFlutterwaveWebhook(req, res) {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).send('Expected raw JSON body.');
    if (!config.flutterwave.secretKey || !config.flutterwave.secretHash) return res.status(503).send('Payment service is not configured.');
    if (!db.isReady()) return res.status(503).send('Database temporarily unavailable.');
    if (!verifyFlutterwaveWebhook(req.body, req.headers, config.flutterwave.secretHash)) {
      return res.status(401).send('Invalid Flutterwave signature.');
    }

    const payload = JSON.parse(req.body.toString('utf8'));
    const { receipt, alreadyProcessed } = await webhookService.receive(req.body, payload);
    res.sendStatus(200);
    if (receipt && !alreadyProcessed) webhookService.enqueue(receipt._id);
  } catch (error) {
    logger.error('Flutterwave webhook intake error:', error.message);
    // Nothing was saved, so ask Flutterwave to retry.
    if (!res.headersSent) res.sendStatus(500);
  }
}

module.exports = { handleFlutterwaveWebhook };
