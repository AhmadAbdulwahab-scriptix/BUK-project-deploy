// Mocks global fetch to check we speak Flutterwave's v3 API correctly (no network needed).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FLW_SECRET_KEY = 'FLWSECK_TEST-x';
const flw = require('../services/flutterwave.service');

const order = {
  reference: 'BUK-1-aaaaaaaaaaaaaaaaaaaaaaaa', amountNaira: 477400, currency: 'NGN',
  email: 'a@x.com', customerName: 'Ada', selectedDomain: 'com'
};
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const reply = (status, body) => async (url, init) => {
  reply.last = { url, init };
  return { ok: status < 400, status, json: async () => body };
};

test('initialize posts naira amount + tx_ref and returns the hosted link', async () => {
  global.fetch = reply(200, { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/abc' } });
  const data = await flw.initializeTransaction(order);
  assert.equal(data.link, 'https://checkout.flutterwave.com/v3/hosted/pay/abc');
  const { url, init } = reply.last;
  assert.equal(url, 'https://api.flutterwave.com/v3/payments');
  assert.equal(init.headers.Authorization, 'Bearer FLWSECK_TEST-x');
  const body = JSON.parse(init.body);
  assert.equal(body.tx_ref, order.reference);
  assert.equal(body.amount, 477400);
  assert.equal(body.customer.email, 'a@x.com');
  assert.match(body.redirect_url, /\/payment\/callback$/);
});

test('verify looks the transaction up by tx_ref', async () => {
  global.fetch = reply(200, { status: 'success', data: { status: 'successful', id: 7 } });
  const data = await flw.verifyTransaction(order.reference);
  assert.equal(data.id, 7);
  assert.match(reply.last.url, /\/transactions\/verify_by_reference\?tx_ref=BUK-1-/);
});

test('"no transaction" is reported as not-found; 5xx and network failures are ambiguous', async () => {
  global.fetch = reply(400, { status: 'error', message: 'No transaction was found for this id' });
  await assert.rejects(flw.verifyTransaction('x'), e => e.isNotFound && !e.ambiguous);

  global.fetch = reply(503, {});
  await assert.rejects(flw.verifyTransaction('x'), e => e.ambiguous === true);

  global.fetch = async () => { throw new Error('socket hang up'); };
  await assert.rejects(flw.initializeTransaction(order), e => e.ambiguous === true);
});
