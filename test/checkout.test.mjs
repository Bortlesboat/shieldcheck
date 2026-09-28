import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createCheckout } from '../src/checkout.mjs';

const expected = { recipient: 'ab'.repeat(43), amountZat: 100000, memo: 'unit-only-order' };
const receipt = { schema: 'shieldcheck-receipt/v1', network: 'regtest', pool: 'ironwood', txid: '12'.repeat(32), actionIndex: 0, ock: '34'.repeat(32) };
const evidence = { network: 'regtest', pool: 'ironwood', genesis: '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327', branchId: '37a5165b', txid: receipt.txid, blockHash: '56'.repeat(32), blockHeight: 103, confirmations: 1, shieldedOnly: true };
const proof = (capability, orderId, challenge) => createHmac('sha256', Buffer.from(capability, 'hex')).update(`shieldcheck-claim/v1\n${orderId}\n${challenge}`).digest('hex');

async function fixture(t, mode, overrides = {}) {
  // An explicit stand-in tests application boundaries; it provides no settlement evidence.
  const seen = [];
  const app = await createCheckout({ mode, expected, shutdownToken: 'test-control', telemetryBase: 'http://127.0.0.1:1' }, {
    verify: async (claim, invoice) => {
      seen.push({ claim, invoice });
      await new Promise(resolve => setTimeout(resolve, 5));
      return JSON.stringify(claim) === JSON.stringify(receipt) && JSON.stringify(invoice) === JSON.stringify(expected)
        ? { status: 'verified', evidence }
        : { status: 'rejected', code: 'invalid_receipt' };
    },
    observe: async () => {},
    ...overrides,
  });
  t.after(() => app.close());
  async function post(path, body) {
    const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const order = (await post('/orders', {})).body;
  return { app, seen, post, order };
}

test('a copied valid receipt obtains access only in the explicitly vulnerable fixture', async t => {
  const vulnerable = await fixture(t, 'vulnerable');
  const weak = await vulnerable.post(`/orders/${vulnerable.order.orderId}/claim`, { receipt });
  assert.equal(weak.status, 200);
  const hardened = await fixture(t, 'hardened');
  const denied = await hardened.post(`/orders/${hardened.order.orderId}/claim`, { receipt });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'authorization_required');
  assert.equal(vulnerable.seen.length, 1);
  assert.equal(hardened.seen.length, 1);
  assert.ok(!hardened.order.memo.includes(hardened.order.capability));
});

test('wrong capability fails; concurrent legitimate claims fulfill exactly once; replay fails', async t => {
  const { app, post, order } = await fixture(t, 'hardened');
  const challenge = (await post(`/orders/${order.orderId}/challenge`, {})).body.challenge;
  const wrong = await post(`/orders/${order.orderId}/claim`, { receipt, challenge, proof: proof('ff'.repeat(32), order.orderId, challenge) });
  assert.equal(wrong.status, 403);
  const body = { receipt, challenge, proof: proof(order.capability, order.orderId, challenge) };
  const results = await Promise.all([post(`/orders/${order.orderId}/claim`, body), post(`/orders/${order.orderId}/claim`, body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(app.stats().fulfillments, 1);
  assert.equal((await post(`/orders/${order.orderId}/claim`, body)).status, 409);
});

test('wrong order, malformed receipt and expired challenge cannot grant access', async t => {
  let now = 1000;
  const { app, post, order } = await fixture(t, 'hardened', { now: () => now });
  const other = (await post('/orders', {})).body;
  assert.equal((await post(`/orders/${other.orderId}/claim`, { receipt })).status, 422);
  assert.equal((await post(`/orders/${order.orderId}/claim`, { receipt: { ...receipt, ock: 'broken' } })).status, 422);
  const challenge = (await post(`/orders/${order.orderId}/challenge`, {})).body.challenge;
  now += 30001;
  const response = await post(`/orders/${order.orderId}/claim`, { receipt, challenge, proof: proof(order.capability, order.orderId, challenge) });
  assert.equal(response.status, 403);
  assert.equal(app.stats().fulfillments, 0);
});

test('unavailable native or capture infrastructure is never reported as an authorization denial', async t => {
  for (const overrides of [{ verify: async () => { throw new Error('private diagnostic'); } }, { observe: async () => { throw new Error('secret sink failure'); } }]) {
    const { app, post, order } = await fixture(t, 'hardened', overrides);
    const response = await post(`/orders/${order.orderId}/claim`, { receipt });
    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'incomplete');
    assert.ok(!JSON.stringify(response).includes('private diagnostic'));
    assert.ok(!JSON.stringify(response).includes('secret sink failure'));
    assert.equal(app.stats().fulfillments, 0);
  }
});
