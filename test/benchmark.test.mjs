import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BRANCH, GENESIS } from '../src/native.mjs';

async function interruptedBenchmark(t, { acceptWrongAmount = false } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'shieldcheck-mocked-native-'));
  const out = join(scratch, 'report');
  t.after(async () => {
    for (const path of ['report/report.json', 'report/report.html', 'pay', 'verify', 'package.json', 'mocked-state.json', 'mocked-events.jsonl']) {
      await unlink(join(scratch, path)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(out).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(scratch);
  });

  // Only the executable contract is mocked. The CLI, checkout child, telemetry
  // sink, capture, cleanup and report rendering all run their production paths.
  // These synthetic transaction fields are not native settlement evidence.
  const mockedReceipt = { schema: 'shieldcheck-receipt/v1', network: 'regtest', pool: 'ironwood', txid: 'ab'.repeat(32), actionIndex: 0, ock: 'cd'.repeat(32) };
  const mockedEvidence = { network: 'regtest', pool: 'ironwood', genesis: GENESIS, branchId: BRANCH, txid: mockedReceipt.txid, blockHash: '12'.repeat(32), blockHeight: 103, confirmations: 1, shieldedOnly: true };
  const mockedNative = `
const fs = require('node:fs');
const { basename } = require('node:path');
const action = basename(process.argv[1]);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const emit = (result, exitCode) => {
  fs.appendFileSync('mocked-events.jsonl', JSON.stringify({ mocked: true, action, pid: process.pid, parentPid: process.ppid, status: result.status }) + '\\n');
  process.stdout.write(JSON.stringify(result));
  process.exitCode = exitCode;
};
if (action === 'pay') {
  const created = { status: 'created', receipt: ${JSON.stringify(mockedReceipt)}, expected: { recipient: 'ef'.repeat(43), amountZat: input.amountZat, memo: input.memo }, evidence: ${JSON.stringify(mockedEvidence)} };
  fs.writeFileSync('mocked-state.json', JSON.stringify({ mocked: true, created, validVerifications: 0 }));
  emit(created, 0);
} else {
  const state = JSON.parse(fs.readFileSync('mocked-state.json', 'utf8'));
  const matches = JSON.stringify(input.receipt) === JSON.stringify(state.created.receipt) && JSON.stringify(input.expected) === JSON.stringify(state.created.expected);
  if (!matches) {
    // The second variant deliberately simulates a broken native verifier before
    // a later outage, so incomplete coverage must not erase its failed control.
    if (${acceptWrongAmount} && input.expected.amountZat === state.created.expected.amountZat + 1) emit({ status: 'verified', evidence: state.created.evidence }, 0);
    else emit({ status: 'rejected', code: 'invalid_receipt' }, 2);
  } else {
    state.validVerifications++;
    fs.writeFileSync('mocked-state.json', JSON.stringify(state));
    // First: benchmark settlement control. Second: copied receipt succeeds and
    // emits disclosures. Third: the owner's later claim loses native service.
    if (state.validVerifications < 3) emit({ status: 'verified', evidence: state.created.evidence }, 0);
    else emit({ status: 'error', code: 'native_unavailable' }, 1);
  }
}
`;
  await writeFile(join(scratch, 'package.json'), '{"type":"commonjs"}\n');
  await writeFile(join(scratch, 'pay'), mockedNative);
  await writeFile(join(scratch, 'verify'), mockedNative);
  // Node resolves its pay/verify script arguments relative to this disposable
  // cwd, including when the real checkout child launches native verification.
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--native', process.execPath, '--rpc-port', '1', '--out', out], {
    cwd: scratch, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.signal, null);
  assert.equal(run.status, 2);
  assert.equal(run.stderr, '');
  assert.deepEqual(JSON.parse(run.stdout), { status: 'incomplete', reports: ['report.json', 'report.html'] });

  const json = await readFile(join(out, 'report.json'), 'utf8');
  const html = await readFile(join(out, 'report.html'), 'utf8');
  const report = JSON.parse(json);
  const check = id => report.checks.find(item => item.id === id)?.status;
  assert.equal(report.status, 'incomplete');
  assert.equal(check('native_amount_mismatch'), acceptWrongAmount ? 'failed' : 'passed');
  assert.equal(check('copied_receipt_vulnerable'), 'passed');
  assert.equal(check('copied_receipt_displaces_owner'), 'incomplete');
  assert.equal(check('vulnerable_leaks'), 'incomplete');
  assert.equal(check('complete_capture'), 'incomplete');
  assert.equal(report.fixtures.length, 1);
  const vulnerable = report.fixtures[0];
  assert.equal(vulnerable.mode, 'vulnerable');
  assert.equal(vulnerable.fulfillments, 1);
  assert.deepEqual(vulnerable.coverage, { status: 'incomplete', reasons: ['missing_or_extra_telemetry'], observedRequests: 2, expectedRequests: 4 });
  for (const expected of [
    { surface: 'stdout', field: 'memo', encoding: 'raw' },
    { surface: 'telemetry_url', field: 'memo', encoding: 'uri' },
    { surface: 'telemetry_body', field: 'receipt', encoding: 'base64' },
  ]) {
    assert.ok(vulnerable.findings.some(finding => Object.entries(expected).every(([key, value]) => finding[key] === value)), `preserved ${expected.surface} disclosure`);
    assert.ok(html.includes(`<strong>${expected.field}</strong> · ${expected.surface.replaceAll('_', ' ')} · ${expected.encoding}`));
  }
  assert.ok(html.includes('Evidence is incomplete.'));

  const state = JSON.parse(await readFile(join(scratch, 'mocked-state.json'), 'utf8'));
  assert.equal(state.mocked, true);
  assert.equal(state.validVerifications, 3);
  const secrets = [state.created.expected.memo, state.created.expected.recipient, JSON.stringify(mockedReceipt), mockedReceipt.ock, mockedReceipt.txid, scratch];
  for (const secret of secrets) {
    for (const encoded of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      assert.ok(!json.includes(encoded), 'public JSON must omit mocked private material');
      assert.ok(!html.includes(encoded), 'public HTML must omit mocked private material');
    }
  }
  assert.doesNotMatch(json + html, /[0-9a-f]{64}/, 'public reports must omit raw keys and capabilities');

  const events = (await readFile(join(scratch, 'mocked-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.every(event => event.mocked));
  assert.equal(events.filter(event => event.status === 'rejected').length, acceptWrongAmount ? 9 : 10);
  assert.deepEqual(events.slice(-2).map(event => event.status), ['verified', 'error']);
  const checkoutPid = events.at(-1).parentPid;
  assert.notEqual(checkoutPid, run.pid);
  assert.equal(events.at(-2).parentPid, checkoutPid);
  assert.deepEqual(new Set(events.map(event => event.parentPid)), new Set([run.pid, checkoutPid]));
  // Probe only PIDs recorded by this run. Do not signal or stop unrelated work.
  // CLI exit also proves its actual telemetry listener no longer holds it open.
  for (const pid of new Set([run.pid, checkoutPid, ...events.map(event => event.pid)])) {
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'owned CLI, checkout and mocked native processes must exit');
  }
}

test('real benchmark preserves disclosures after later mocked native unavailability', t => interruptedBenchmark(t));

test('a failed mocked native negative survives later incomplete capture without a passing CLI result', t => interruptedBenchmark(t, { acceptWrongAmount: true }));
