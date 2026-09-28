import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const checkoutPath = fileURLToPath(new URL('../src/checkout.mjs', import.meta.url));
const expected = { recipient: 'ab'.repeat(43), amountZat: 1, memo: 'mock-parent-exit-test' };
const receipt = { schema: 'shieldcheck-receipt/v1', network: 'regtest', pool: 'ironwood', txid: '12'.repeat(32), actionIndex: 0, ock: '34'.repeat(32) };

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function ownedFixture(t) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'shieldcheck-parent-exit-'));
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  assert.ok(path.basename(directory).startsWith('shieldcheck-parent-exit-'));
  const nativePidPath = path.join(directory, 'mock-native-pid.json');
  const preloadPath = path.join(directory, 'mock-native.mjs');
  // Only this synthetic verifier blocks. It produces no settlement evidence.
  await writeFile(preloadPath, `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    if (path.basename(process.argv[1] ?? '') === 'verify') {
      for await (const chunk of process.stdin) { /* Drain the bounded fixture input. */ }
      await writeFile(${JSON.stringify(nativePidPath)}, JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  `);
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(checkoutPath)}], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    process.send({ kind: 'owned_checkout', pid: child.pid });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\\n')) >= 0) {
        const event = JSON.parse(output.slice(0, newline));
        output = output.slice(newline + 1);
        if (event.kind === 'ready') process.send(event);
      }
    });
    child.stderr.resume();
    child.stdin.end(${JSON.stringify(JSON.stringify({ mode: 'hardened', expected, native: process.execPath, rpcPort: 1, telemetryBase: 'http://127.0.0.1:1', shutdownToken: 'mock-parent-exit-control' }))});
    process.on('message', () => { throw new Error('mock_parent_failure'); });
  `;
  const parent = spawn(process.execPath, ['-e', source], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
  });
  parent.stdout.resume();
  parent.stderr.resume();
  const ownedPids = new Set(parent.pid ? [parent.pid] : []);
  let checkoutPid, url, spawnError;
  parent.on('error', error => { spawnError = error; });
  parent.on('message', message => {
    if (message.kind === 'owned_checkout') { checkoutPid = message.pid; ownedPids.add(checkoutPid); }
    if (message.kind === 'ready') url = `http://127.0.0.1:${message.port}`;
  });
  t.after(async () => {
    // These PIDs came only from our own spawn handle and its explicitly tracked children.
    for (const pid of ownedPids) if (running(pid)) process.kill(pid);
    await waitFor(() => [...ownedPids].every(pid => !running(pid)), 'owned test processes did not stop');
    await rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => { if (spawnError) throw spawnError; return url; }, 'checkout did not start');
  assert.ok(running(parent.pid));
  assert.ok(running(checkoutPid));
  return {
    url,
    async waitForNative() {
      const nativePid = await waitFor(async () => {
        try { return JSON.parse(await readFile(nativePidPath, 'utf8')).pid; }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
      }, 'mock native verifier did not start');
      ownedPids.add(nativePid);
      assert.ok(running(nativePid), 'the native helper must be active before its owner exits');
    },
    async crashAndVerifyCleanup() {
      const exited = once(parent, 'exit');
      parent.send({ crash: true });
      const [code] = await exited;
      assert.equal(code, 1);
      await waitFor(() => [...ownedPids].every(pid => !running(pid)), 'a checkout or native helper survived its parent');
      ownedPids.clear();
      await assert.rejects(fetch(`${url}/orders`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) }));
    },
  };
}

// The documented launcher is Windows/WSL. This establishes Windows containment
// with the real, non-detached checkout topology; it makes no other-platform claim.
for (const inFlight of [false, true]) {
  test(`Windows cleans up the owned checkout on parent failure${inFlight ? ' with an active mocked native verifier' : ''}`, { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const fixture = await ownedFixture(t);
    const orderResponse = await fetch(`${fixture.url}/orders`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    assert.equal(orderResponse.status, 201);
    const order = await orderResponse.json();
    let claim;
    if (inFlight) {
      claim = fetch(`${fixture.url}/orders/${order.orderId}/claim`, { method: 'POST', body: JSON.stringify({ receipt }), signal: AbortSignal.timeout(10000) }).then(response => response.text()).catch(() => undefined);
      await fixture.waitForNative();
    }
    await fixture.crashAndVerifyCleanup();
    await claim;
  });
}
