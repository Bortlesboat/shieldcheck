import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { claimProof } from './claim-proof.mjs';
import { verifyPayment, validExpected, validReceipt } from './native.mjs';

const randomHex = size => randomBytes(size).toString('hex');
const safeEqual = (left, right) => typeof left === 'string' && /^[0-9a-f]{64}$/.test(left)
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

export async function readJson(stream, limit = 32768) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('invalid_input');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function telemetry(config, receipt, expected) {
  const endpoint = `${config.telemetryBase}/${config.mode}`;
  if (config.mode === 'vulnerable') process.stdout.write(`${JSON.stringify({ kind: 'checkout_event', memo: expected.memo })}\n`);
  const url = config.mode === 'vulnerable' ? `${endpoint}?memo=${encodeURIComponent(expected.memo)}` : `${endpoint}?event=settlement_checked`;
  const body = config.mode === 'vulnerable' ? Buffer.from(JSON.stringify(receipt)).toString('base64') : 'settlement_checked';
  for (const [target, options] of [[url, {}], [endpoint, { method: 'POST', body }]]) {
    const response = await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.status !== 204) throw new Error('capture_unavailable');
    await response.arrayBuffer();
  }
}

export async function createCheckout(config, dependencies = {}) {
  if (!['vulnerable', 'hardened'].includes(config.mode) || !validExpected(config.expected)) throw new Error('invalid_fixture');
  const telemetryAddress = new URL(config.telemetryBase);
  if (telemetryAddress.protocol !== 'http:' || telemetryAddress.hostname !== '127.0.0.1' || !telemetryAddress.port || telemetryAddress.pathname !== '/' || telemetryAddress.search || telemetryAddress.hash || telemetryAddress.username || telemetryAddress.password) throw new Error('invalid_fixture');
  const verify = dependencies.verify ?? ((receipt, expected) => verifyPayment(config.native, { rpcPort: config.rpcPort, receipt, expected }));
  const observe = dependencies.observe ?? ((receipt, expected) => telemetry(config, receipt, expected));
  const now = dependencies.now ?? Date.now;
  const orders = new Map();
  let claims = 0, fulfillments = 0;
  const send = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  let closing;
  const close = () => closing ??= new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') return send(response, 405, { status: 'rejected', code: 'method_not_allowed' });
      const body = await readJson(request);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return send(response, 400, { status: 'rejected', code: 'invalid_input' });
      if (request.url === '/shutdown' && request.headers['x-fixture-control'] === config.shutdownToken) {
        send(response, 200, { status: 'stopping' });
        await close();
        dependencies.onStopped?.({ claims, fulfillments });
        return;
      }
      if (request.url === '/orders') {
        if (orders.size >= 4) return send(response, 429, { status: 'rejected', code: 'fixture_order_limit' });
        const orderId = randomHex(16), capability = randomHex(32);
        const expected = { ...config.expected, memo: orders.size === 0 ? config.expected.memo : `${config.expected.memo}:${orderId}` };
        orders.set(orderId, { expected, capability, challenges: new Map(), fulfilled: false });
        return send(response, 201, { orderId, capability, memo: expected.memo, policy: 'nontransferable_order_capability' });
      }
      const match = /^\/orders\/([0-9a-f]{32})\/(challenge|claim)$/.exec(request.url);
      const order = match && orders.get(match[1]);
      if (!order) return send(response, 404, { status: 'rejected', code: 'unknown_order' });
      if (match[2] === 'challenge') {
        for (const [challenge, expiry] of order.challenges) if (expiry <= now()) order.challenges.delete(challenge);
        if (order.challenges.size >= 4) return send(response, 429, { status: 'rejected', code: 'challenge_limit' });
        const challenge = randomHex(32);
        order.challenges.set(challenge, now() + 30000);
        return send(response, 200, { challenge, expiresInMs: 30000 });
      }
      claims++;
      if (!validReceipt(body.receipt)) return send(response, 422, { status: 'rejected', code: 'invalid_receipt' });
      let checked;
      try { checked = await verify(body.receipt, order.expected); }
      catch { return send(response, 503, { status: 'incomplete', code: 'native_unavailable' }); }
      if (checked.status === 'rejected') return send(response, 422, { status: 'rejected', code: 'invalid_receipt' });
      if (checked.status !== 'verified') return send(response, 503, { status: 'incomplete', code: 'native_unavailable' });
      try { await observe(body.receipt, order.expected); }
      catch { return send(response, 503, { status: 'incomplete', code: 'capture_unavailable' }); }
      // No await occurs between the authorization decision and fulfillment. Concurrent
      // verified requests therefore cannot both consume one order in this process.
      if (order.fulfilled) return send(response, 409, { status: 'rejected', code: 'already_fulfilled', payment: 'verified' });
      if (config.mode === 'hardened') {
        const expires = order.challenges.get(body.challenge);
        const expectedProof = claimProof(order.capability, match[1], body.challenge);
        if (!expires || expires <= now() || !safeEqual(body.proof, expectedProof)) {
          return send(response, 403, { status: 'rejected', code: 'authorization_required', payment: 'verified' });
        }
        order.challenges.delete(body.challenge);
      }
      order.fulfilled = true;
      fulfillments++;
      send(response, 200, { status: 'fulfilled', payment: 'verified', fulfillmentNumber: fulfillments });
    } catch { send(response, 400, { status: 'rejected', code: 'invalid_input' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close, stats: () => ({ claims, fulfillments }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await readJson(process.stdin);
    const app = await createCheckout(config, { onStopped: stats => process.stdout.write(`${JSON.stringify({ kind: 'finished', ...stats })}\n`) });
    process.stdout.write(`${JSON.stringify({ kind: 'ready', port: Number(new URL(app.url).port) })}\n`);
  } catch {
    process.stderr.write('fixture_unavailable\n');
    process.exitCode = 1;
  }
}
