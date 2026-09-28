import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { claimProof } from './claim-proof.mjs';
import { Capture, evaluateCoverage } from './coverage.mjs';
import { createPayment, verifyPayment } from './native.mjs';
import { CHECKS, publicReport } from './render.mjs';

class Incomplete extends Error {}
class Failed extends Error {}

async function post(url, path, body, headers = {}) {
  try {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(40000) });
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) { await reader.cancel(); throw new Incomplete(); }
      chunks.push(Buffer.from(value));
    }
    const result = { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    if (response.status === 503 || result.body?.status === 'incomplete') throw new Incomplete();
    return result;
  } catch { throw new Incomplete(); }
}

async function telemetrySink() {
  const modes = Object.fromEntries(['vulnerable', 'hardened'].map(mode => [mode, { requests: 0, dropped: 0, urls: new Capture('telemetry_url'), bodies: new Capture('telemetry_body') }]));
  const server = http.createServer(async (request, response) => {
    const mode = /^\/(vulnerable|hardened)(?:\?|$)/.exec(request.url)?.[1];
    const capture = modes[mode];
    if (!capture) { response.writeHead(400).end(); return; }
    capture.urls.append(`${request.url}\n`);
    let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        capture.bodies.append(chunk);
      }
      capture.bodies.append('\n');
      if (bytes > 32768) { capture.dropped++; response.writeHead(413).end(); return; }
      capture.requests++;
      response.writeHead(204).end();
    } catch { capture.dropped++; response.destroy(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { modes, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}

async function checkoutChild(config, sinkCapture) {
  const stdout = new Capture('stdout'), stderr = new Capture('stderr');
  const state = { childReady: false, childFinished: false, exitCode: null, timedOut: false, expectedRequests: config.mode === 'vulnerable' ? 4 : 10 };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./checkout.mjs', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', fulfillments = null, readyResolve, readyReject, closeResolve, stopping;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const readyTimer = setTimeout(() => { state.timedOut = true; child.kill(); readyReject(new Incomplete()); }, 10000);
  const lifetime = setTimeout(() => { state.timedOut = true; child.kill(); }, 180000);
  child.stdout.on('data', chunk => {
    stdout.append(chunk);
    if (stdout.overflow) return;
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.kind === 'ready' && !state.childReady && Number.isInteger(event.port) && event.port > 0 && event.port < 65536) {
          state.childReady = true;
          clearTimeout(readyTimer);
          readyResolve(`http://127.0.0.1:${event.port}`);
        }
        if (event.kind === 'finished' && Number.isSafeInteger(event.fulfillments) && event.fulfillments >= 0) {
          state.childFinished = true;
          fulfillments = event.fulfillments;
        }
      } catch { /* Application log lines are observations, not control messages. */ }
    }
  });
  child.stderr.on('data', chunk => stderr.append(chunk));
  child.on('error', () => { readyReject(new Incomplete()); });
  child.stdin.on('error', () => { readyReject(new Incomplete()); });
  child.on('close', code => {
    state.exitCode = code;
    clearTimeout(readyTimer);
    clearTimeout(lifetime);
    if (!state.childReady) readyReject(new Incomplete());
    closeResolve();
  });
  child.stdin.end(JSON.stringify(config));
  let url;
  try { url = await ready; }
  catch {
    child.kill();
    await closed;
    // The returned object still retains every observation collected before failure.
  }
  const captures = [stdout, stderr, sinkCapture.urls, sinkCapture.bodies];
  const finish = () => stopping ??= (async () => {
    if (url && state.exitCode === null) {
      try { await post(url, '/shutdown', {}, { 'x-fixture-control': config.shutdownToken }); }
      catch { child.kill(); }
    } else if (state.exitCode === null) child.kill();
    await closed;
  })();
  return {
    url,
    finish,
    report(canaries) {
      const coverageState = { ...state, observedRequests: sinkCapture.requests, droppedRequests: sinkCapture.dropped };
      return { mode: config.mode, fulfillments, findings: captures.flatMap(capture => capture.findings(canaries)), coverage: evaluateCoverage(coverageState, captures) };
    },
  };
}

export async function runBenchmark({ native, rpcPort }) {
  const result = { createdAt: new Date().toISOString(), status: 'incomplete', native: { status: 'unavailable' }, checks: [], fixtures: [] };
  const children = [];
  const canaries = [];
  let sink, activeCheck;
  const check = (id, passed) => {
    activeCheck = id;
    result.checks.push({ id, status: passed ? 'passed' : 'failed' });
  };
  const request = async (fixture, path, body) => {
    if (!fixture.url) throw new Incomplete();
    return post(fixture.url, path, body);
  };
  try {
    activeCheck = 'native_settlement';
    const created = await createPayment(native, { rpcPort, memo: `shieldcheck:${randomUUID()} /+`, amountZat: 100000 });
    const { receipt, expected } = created;
    canaries.push(...Object.entries({ memo: expected.memo, receipt: JSON.stringify(receipt), ock: receipt.ock, recipient: expected.recipient }).map(([name, value]) => ({ name, value })));
    const verified = await verifyPayment(native, { rpcPort, receipt, expected });
    check('native_settlement', verified.status === 'verified');
    if (verified.status !== 'verified') throw new Failed();
    result.native = { status: 'verified', ...verified.evidence };

    const nativeNegatives = [
      ['native_amount_mismatch', receipt, { ...expected, amountZat: expected.amountZat + 1 }],
      ['native_memo_mismatch', receipt, { ...expected, memo: `${expected.memo}-mismatch` }],
      ['native_recipient_mismatch', receipt, { ...expected, recipient: '00'.repeat(43) }],
      ['native_malformed', { ...receipt, actionIndex: 'not-an-index' }, expected],
      ['native_zero_ock', { ...receipt, ock: '00'.repeat(32) }, expected],
      ['native_malformed_ock', { ...receipt, ock: 'invalid' }, expected],
      ['native_unknown_txid', { ...receipt, txid: '00'.repeat(32) }, expected],
      ['native_wrong_action', { ...receipt, actionIndex: 1023 }, expected],
      ['native_wrong_network', { ...receipt, network: 'mainnet' }, expected],
      ['native_wrong_pool', { ...receipt, pool: 'orchard' }, expected],
    ];
    for (const [id, disclosed, invoice] of nativeNegatives) {
      activeCheck = id;
      const response = await verifyPayment(native, { rpcPort, receipt: disclosed, expected: invoice });
      check(id, response.status === 'rejected');
    }

    sink = await telemetrySink();
    for (const mode of ['vulnerable', 'hardened']) {
      const child = await checkoutChild({ native, rpcPort, mode, expected, telemetryBase: sink.url, shutdownToken: randomBytes(32).toString('hex') }, sink.modes[mode]);
      children.push(child);
      if (!child.url) throw new Incomplete();
      const orderResponse = await request(child, '/orders', {});
      const order = orderResponse.body;
      if (orderResponse.status !== 201 || !/^[0-9a-f]{32}$/.test(order.orderId) || !/^[0-9a-f]{64}$/.test(order.capability) || order.memo !== expected.memo || order.memo.includes(order.capability)) throw new Incomplete();
      canaries.push({ name: 'capability', value: order.capability });
      activeCheck = `copied_receipt_${mode}`;
      const copied = await request(child, `/orders/${order.orderId}/claim`, { receipt });
      check(activeCheck, mode === 'vulnerable'
        ? copied.status === 200 && copied.body.status === 'fulfilled' && copied.body.payment === 'verified'
        : copied.status === 403 && copied.body.code === 'authorization_required' && copied.body.payment === 'verified');
      const challengeResult = await request(child, `/orders/${order.orderId}/challenge`, {});
      const challenge = challengeResult.body.challenge;
      if (challengeResult.status !== 200 || !/^[0-9a-f]{64}$/.test(challenge)) throw new Incomplete();
      const legitimate = { receipt, challenge, proof: claimProof(order.capability, order.orderId, challenge) };
      if (mode === 'vulnerable') {
        activeCheck = 'copied_receipt_displaces_owner';
        const displaced = await request(child, `/orders/${order.orderId}/claim`, legitimate);
        check(activeCheck, displaced.status === 409 && displaced.body.code === 'already_fulfilled' && displaced.body.payment === 'verified');
      } else {
        activeCheck = 'wrong_capability';
        const wrong = await request(child, `/orders/${order.orderId}/claim`, { ...legitimate, proof: claimProof('00'.repeat(32), order.orderId, challenge) });
        check(activeCheck, wrong.status === 403 && wrong.body.code === 'authorization_required' && wrong.body.payment === 'verified');
        activeCheck = 'concurrency';
        const concurrent = await Promise.all([request(child, `/orders/${order.orderId}/claim`, legitimate), request(child, `/orders/${order.orderId}/claim`, legitimate)]);
        check('legitimate_access', concurrent.filter(response => response.status === 200 && response.body.status === 'fulfilled' && response.body.payment === 'verified').length === 1);
        check('concurrency', concurrent.filter(response => response.status === 409 && response.body.code === 'already_fulfilled').length === 1 && concurrent.every(response => response.body.payment === 'verified'));
        activeCheck = 'replay';
        const replay = await request(child, `/orders/${order.orderId}/claim`, legitimate);
        check(activeCheck, replay.status === 409 && replay.body.code === 'already_fulfilled' && replay.body.payment === 'verified');
        activeCheck = 'wrong_order';
        const otherOrder = (await request(child, '/orders', {})).body;
        canaries.push({ name: 'capability', value: otherOrder.capability }, { name: 'memo', value: otherOrder.memo });
        const wrongOrder = await request(child, `/orders/${otherOrder.orderId}/claim`, { receipt, expected });
        check(activeCheck, wrongOrder.status === 422 && wrongOrder.body.code === 'invalid_receipt');
        activeCheck = 'modified_disclosure';
        const modifiedReceipt = { ...receipt, ock: `${receipt.ock[0] === '0' ? '1' : '0'}${receipt.ock.slice(1)}` };
        const modified = await request(child, `/orders/${order.orderId}/claim`, { receipt: modifiedReceipt });
        check(activeCheck, modified.status === 422 && modified.body.code === 'invalid_receipt');
        activeCheck = 'malformed_receipt';
        const malformed = await request(child, `/orders/${order.orderId}/claim`, { receipt: { ...receipt, schema: 'unknown' } });
        check(activeCheck, malformed.status === 422 && malformed.body.code === 'invalid_receipt');
      }
      await child.finish();
    }
    result.status = result.checks.some(item => item.status === 'failed') ? 'failed' : 'completed';
  } catch (error) {
    result.status = error instanceof Failed ? 'failed' : 'incomplete';
    if (activeCheck && !result.checks.some(item => item.id === activeCheck)) result.checks.push({ id: activeCheck, status: result.status === 'failed' ? 'failed' : 'incomplete' });
  } finally {
    for (const child of children) await child.finish();
    if (sink) await sink.close();
    result.fixtures = children.map(child => child.report(canaries));
  }

  const vulnerable = result.fixtures.find(fixture => fixture.mode === 'vulnerable');
  const hardened = result.fixtures.find(fixture => fixture.mode === 'hardened');
  const completeCapture = result.fixtures.length === 2 && result.fixtures.every(fixture => fixture.coverage.status === 'complete');
  const addObservation = (id, condition, complete) => result.checks.push({ id, status: complete ? (condition ? 'passed' : 'failed') : 'incomplete' });
  addObservation('vulnerable_leaks', vulnerable?.findings.some(finding => finding.field === 'memo' && finding.surface === 'stdout')
    && vulnerable?.findings.some(finding => finding.field === 'memo' && finding.surface === 'telemetry_url' && finding.encoding === 'uri')
    && vulnerable?.findings.some(finding => finding.field === 'receipt' && finding.surface === 'telemetry_body' && finding.encoding === 'base64'), vulnerable?.coverage.status === 'complete');
  addObservation('hardened_no_leaks', hardened?.findings.length === 0, hardened?.coverage.status === 'complete');
  addObservation('complete_capture', completeCapture, completeCapture);
  if (!completeCapture || result.status === 'incomplete') result.status = 'incomplete';
  else if (result.checks.some(item => item.status === 'failed')) result.status = 'failed';
  for (const id of Object.keys(CHECKS)) if (!result.checks.some(check => check.id === id)) result.checks.push({ id, status: 'incomplete' });
  return publicReport(result);
}
