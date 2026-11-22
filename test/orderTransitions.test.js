const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyVerification, applyVerification } = require('../helpers/orderTransitions');

const baseOrder = (overrides = {}) => ({
  reference: 'BUK-1-aaaaaaaaaaaaaaaaaaaaaaaa', currency: 'NGN', amountNaira: 477400,
  status: 'pending', email: 'a@x.com', activeCheckoutEmail: 'a@x.com', ...overrides
});
const verifiedFor = (order, overrides = {}) => ({
  status: 'successful', tx_ref: order.reference, currency: order.currency, amount: order.amountNaira,
  id: 99, payment_type: 'card', created_at: '2026-11-03T10:00:00Z', ...overrides
});

test('matching success marks the order paid and releases the email lock', () => {
  const order = baseOrder();
  assert.equal(applyVerification(order, verifiedFor(order)), 'paid');
  assert.equal(order.status, 'paid');
  assert.equal(order.flutterwaveTransactionId, 99);
  assert.equal(order.activeCheckoutEmail, undefined);
});

test('wrong amount, currency or reference goes to review, never paid', () => {
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { tx_ref: 'other' }]) {
    const order = baseOrder();
    assert.equal(applyVerification(order, verifiedFor(order, change)), 'review-required');
    assert.equal(order.status, 'review_required');
  }
});

test('a stale failed result never downgrades a paid or refunded order', () => {
  for (const status of ['paid', 'refunded']) {
    const order = baseOrder({ status });
    applyVerification(order, verifiedFor(order, { status: 'failed' }));
    assert.equal(order.status, status);
  }
});

test('failed is recorded and releases the email lock', () => {
  const order = baseOrder();
  assert.equal(applyVerification(order, verifiedFor(order, { status: 'failed' })), 'failed');
  assert.equal(order.status, 'failed');
  assert.equal(order.activeCheckoutEmail, undefined);
});

test('pending result moves live orders to verification_pending but leaves closed ones alone', () => {
  const live = baseOrder();
  applyVerification(live, verifiedFor(live, { status: 'pending' }));
  assert.equal(live.status, 'verification_pending');

  const expired = baseOrder({ status: 'expired', activeCheckoutEmail: undefined });
  applyVerification(expired, verifiedFor(expired, { status: 'pending' }));
  assert.equal(expired.status, 'expired');
  assert.equal(expired.activeCheckoutEmail, undefined);
});

test('a late success still pays an expired order', () => {
  const order = baseOrder({ status: 'expired' });
  assert.equal(applyVerification(order, verifiedFor(order)), 'paid');
});

test('unknown Flutterwave statuses are treated as pending, never paid', () => {
  const order = baseOrder();
  assert.equal(classifyVerification(verifiedFor(order, { status: 'something-new' }), order), 'pending');
});
