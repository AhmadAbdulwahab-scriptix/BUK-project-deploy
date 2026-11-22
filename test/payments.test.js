const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { calculatePrice, verifyFlutterwaveWebhook, makeReference } = require('../helpers/payments');

test('calculates the .com package in whole naira', () => {
  assert.deepEqual(calculatePrice('com'), { amountNaira: 477400 });
});

test('calculates the .ng package in whole naira', () => {
  assert.deepEqual(calculatePrice('ng'), { amountNaira: 462000 });
});

test('rejects unknown domain selections', () => {
  assert.throws(() => calculatePrice('org'), /Unsupported domain/);
});

test('accepts a webhook only when verif-hash matches the secret hash', () => {
  const secret = 'test-secret-hash';
  const body = Buffer.from('{"event":"charge.completed","data":{"tx_ref":"abc"}}');
  assert.equal(verifyFlutterwaveWebhook(body, { 'verif-hash': secret }, secret), true);
  assert.equal(verifyFlutterwaveWebhook(body, { 'verif-hash': 'wrong-hash!!!!!!' }, secret), false);
  assert.equal(verifyFlutterwaveWebhook(body, {}, secret), false);
  assert.equal(verifyFlutterwaveWebhook(body, { 'verif-hash': secret }, undefined), false);
});

test('accepts a valid flutterwave-signature HMAC over the exact raw body', () => {
  const secret = 'test-secret-hash';
  const body = Buffer.from('{"event":"charge.completed","data":{"tx_ref":"abc"}}');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyFlutterwaveWebhook(body, { 'flutterwave-signature': signature }, secret), true);
  assert.equal(verifyFlutterwaveWebhook(Buffer.from('{}'), { 'flutterwave-signature': signature }, secret), false);
});

test('generates distinct, high-entropy order references', () => {
  const first = makeReference();
  const second = makeReference();
  assert.match(first, /^BUK-\d+-[a-f0-9]{24}$/);
  assert.notEqual(first, second);
});

test('fingerprint ignores email case but not other details', () => {
  const { fingerprint } = require('../helpers/payments');
  const a = fingerprint({ domain: 'com', email: 'A@x.com', fullName: 'Ada' });
  assert.equal(a, fingerprint({ domain: 'com', email: 'a@x.com', fullName: 'Ada' }));
  assert.notEqual(a, fingerprint({ domain: 'ng', email: 'a@x.com', fullName: 'Ada' }));
});

test('backoffDelay grows, is capped, and is jittered between 50% and 100%', () => {
  const { backoffDelay } = require('../helpers/payments');
  const policy = { baseMs: 1000, maxMs: 8000 };
  assert.equal(backoffDelay(0, policy, () => 1), 1000);
  assert.equal(backoffDelay(2, policy, () => 1), 4000);
  assert.equal(backoffDelay(10, policy, () => 1), 8000);
  assert.equal(backoffDelay(2, policy, () => 0), 2000);
});
