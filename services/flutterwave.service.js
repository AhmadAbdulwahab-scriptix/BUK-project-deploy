// The only file that talks to Flutterwave (API v3) over HTTP. Everything else calls these functions.
// Flutterwave amounts are in MAJOR units (naira, not kobo).
const config = require('../config');

class FlutterwaveError extends Error {
  /**
   * @param {object} opts
   * @param {number} [opts.statusCode] HTTP status from Flutterwave (absent for network failures)
   * @param {boolean} opts.ambiguous  true when Flutterwave MAY have processed the request anyway
   */
  constructor(message, { statusCode, ambiguous }) {
    super(message);
    this.name = 'FlutterwaveError';
    this.statusCode = statusCode;
    this.ambiguous = ambiguous;
  }
  // verify_by_reference answers with an error when no transaction exists for that tx_ref yet.
  get isNotFound() { return this.statusCode === 404 || /no transaction|not found/i.test(this.message); }
  get isDuplicateReference() { return /duplicate|already (been )?(used|exists?)/i.test(this.message); }
}

async function request(endpoint, { timeoutMs = config.flutterwave.timeoutMs, ...options } = {}) {
  if (!config.flutterwave.secretKey) throw new FlutterwaveError('FLW_SECRET_KEY is not configured.', { ambiguous: false });

  let response;
  try {
    response = await fetch(`${config.flutterwave.apiUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.flutterwave.secretKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    // Timeouts and dropped connections: we do not know whether Flutterwave acted on the request.
    throw new FlutterwaveError(`Flutterwave request failed: ${error.message}`, { ambiguous: true });
  }

  // A gateway error page is HTML, not JSON, so parsing can fail.
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== 'success') {
    throw new FlutterwaveError(result.message || `Flutterwave request failed (${response.status}).`, {
      statusCode: response.status,
      ambiguous: response.status >= 500
    });
  }
  return result.data;
}

/** Look a transaction up by OUR reference (tx_ref). Works before we know Flutterwave's numeric id. */
function verifyTransaction(reference, options) {
  return request(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, options);
}

/** Creates a hosted checkout and returns { link }. */
function initializeTransaction(order) {
  return request('/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref: order.reference,
      amount: order.amountNaira,
      currency: order.currency,
      redirect_url: `${config.baseUrl}/payment/callback`,
      customer: { email: order.email, name: order.customerName },
      customizations: { title: 'Student External Defence Hosting Portal' },
      // Keep the hosted page alive for as long as the order itself (Flutterwave max is 1440 min).
      configurations: { session_duration: Math.min(1440, Math.round(config.order.lifetimeMs / 60000)) },
      meta: {
        selected_domain: order.selectedDomain
      }
    })
  });
}

module.exports = { FlutterwaveError, verifyTransaction, initializeTransaction };
