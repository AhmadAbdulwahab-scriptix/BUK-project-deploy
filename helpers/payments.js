const crypto = require('crypto');

// Plain naira prices (no currency conversion anywhere)
const PRICES_Naira = Object.freeze({
  hosting: 210000,    // Hosting package
  database: 70000,    // Database service
  domainCom: 80000,   // .com domain
  domainNg: 70000,    // .ng domain
  totalCom: 360000,   // hosting + database + .com domain
  totalNg: 350000     // hosting + database + .ng domain
});

const REFERENCE_PATTERN = /^BUK-\d+-[a-f0-9]{24}$/;

function calculatePrice(domain) {
  if (!['com', 'ng'].includes(domain)) throw new Error('Unsupported domain selection.');
  if (domain === 'com') {
    return {
      amountNaira: PRICES_Naira.totalCom
    };
  }
  return {
    amountNaira: PRICES_Naira.totalNg
  };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Flutterwave proves a webhook is genuine in one of two ways, so we accept either:
 *  - `verif-hash`: the secret hash you set in the dashboard, echoed back verbatim.
 *  - `flutterwave-signature`: base64 HMAC-SHA256 of the raw body, keyed with that same secret hash.
 */
function verifyFlutterwaveWebhook(rawBody, headers = {}, secretHash) {
  if (!Buffer.isBuffer(rawBody) || !secretHash) return false;
  const plain = headers['verif-hash'];
  if (typeof plain === 'string' && plain && safeEqual(plain, secretHash)) return true;
  const signature = headers['flutterwave-signature'];
  if (typeof signature === 'string' && signature) {
    const expected = crypto.createHmac('sha256', secretHash).update(rawBody).digest('base64');
    return safeEqual(signature, expected);
  }
  return false;
}

function makeReference() {
  return `BUK-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
}

// Binds an idempotency key to the exact form details it was first used with.
function fingerprint({ domain, email, fullName }) {
  return crypto.createHash('sha256').update(`${domain}|${email.toLowerCase()}|${fullName}`).digest('hex');
}

function hashBody(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

// Exponential backoff with jitter: base * 2^attempt, capped, then scaled to 50-100%
// so many orders do not all become due at the same instant.
function backoffDelay(attempt, { baseMs, maxMs }, rng = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.5 + rng() * 0.5));
}

module.exports = {
  PRICES_Naira, REFERENCE_PATTERN,
  calculatePrice, verifyFlutterwaveWebhook, makeReference, fingerprint, hashBody, backoffDelay
};