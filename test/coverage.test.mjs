import assert from 'node:assert/strict';
import test from 'node:test';
import { Capture, evaluateCoverage } from '../src/coverage.mjs';
import { renderReport, publicReport } from '../src/render.mjs';

test('capture identifies known encodings without including canary values', () => {
  const secret = 'private memo /+a';
  const capture = new Capture('telemetry', 2048);
  capture.append(`${secret}|${encodeURIComponent(secret)}|${Buffer.from(secret).toString('base64')}`);
  const findings = capture.findings([{ name: 'memo', value: secret }]);
  assert.deepEqual(findings.map(item => item.encoding).sort(), ['base64', 'raw', 'uri']);
  assert.ok(!JSON.stringify(findings).includes(secret));
});

test('telemetry URLs reveal the full canary through standard query serializations', () => {
  const secret = 'shieldcheck:11111111-2222-3333-4444-555555555555 /+';
  const urls = [
    `http://127.0.0.1/collect?memo=${encodeURIComponent(secret)}`,
    new Request(`http://127.0.0.1/collect?memo=${secret}`).url,
    `http://127.0.0.1/collect?${new URLSearchParams({ memo: secret })}`,
  ];
  for (const url of urls) {
    const parsed = new URL(url);
    const capture = new Capture('telemetry_url');
    capture.append(parsed.pathname + parsed.search);
    assert.deepEqual(capture.findings([{ name: 'memo', value: secret }]), [
      { surface: 'telemetry_url', field: 'memo', encoding: 'uri' },
    ], url);
  }
  const combined = new Capture('telemetry_url');
  combined.append(urls.join('\n'));
  assert.equal(combined.findings([{ name: 'memo', value: secret }]).length, 1);
});

test('query matching stays on telemetry URLs and does not match a truncated canary', () => {
  const secret = 'private memo /+a';
  const normalized = new URL(`http://127.0.0.1/?memo=${secret}`).search;
  const otherSurface = new Capture('stdout');
  otherSurface.append(normalized);
  assert.deepEqual(otherSurface.findings([{ name: 'memo', value: secret }]), []);

  for (const value of [secret, `${secret}#tail`, `${secret}\ntail`]) {
    const capture = new Capture('telemetry_url');
    const url = new URL(`http://127.0.0.1/?memo=${value === secret ? secret.slice(0, -1) : value}`);
    capture.append(url.pathname + url.search);
    assert.deepEqual(capture.findings([{ name: 'memo', value }]), []);
  }
});

const receipt = {
  schema: 'shieldcheck-receipt/v1', network: 'regtest', pool: 'ironwood',
  txid: 'ab'.repeat(32), actionIndex: 0, ock: 'cd'.repeat(32),
};
const receiptCanaries = [
  { name: 'receipt', value: JSON.stringify(receipt) },
  { name: 'ock', value: receipt.ock },
];

test('one Base64 JSON envelope reveals whole receipt and output key at every byte alignment', () => {
  const envelope = JSON.stringify({ event: 'checkout_claim_checked', requestId: '11111111-2222-3333-4444-555555555555', receipt });
  assert.equal(Buffer.byteLength(envelope), 332);
  const alignments = new Set(), paddingLengths = new Set();
  for (let prefix = 0; prefix < 3; prefix++) {
    for (let suffix = 0; suffix < 3; suffix++) {
      const body = `${' '.repeat(prefix)}${envelope}${' '.repeat(suffix)}`;
      alignments.add(body.indexOf(JSON.stringify(receipt)) % 3);
      const encoded = Buffer.from(body).toString('base64');
      paddingLengths.add(encoded.length - encoded.replace(/=+$/, '').length);
      const capture = new Capture('telemetry_body', 2048);
      capture.append(encoded.slice(0, 101));
      capture.append(encoded.slice(101));
      assert.deepEqual(capture.findings(receiptCanaries), [
        { surface: 'telemetry_body', field: 'receipt', encoding: 'base64' },
        { surface: 'telemetry_body', field: 'ock', encoding: 'base64' },
      ], `prefix ${prefix}, suffix ${suffix}`);
      assert.ok(!JSON.stringify(capture.findings(receiptCanaries)).includes(receipt.ock));
    }
  }
  assert.deepEqual([...alignments].sort(), [0, 1, 2]);
  assert.deepEqual([...paddingLengths].sort(), [0, 1, 2]);

  const standalone = new Capture('telemetry_body');
  standalone.append(JSON.stringify({ payload: Buffer.from(JSON.stringify(receipt)).toString('base64') }));
  assert.deepEqual(standalone.findings(receiptCanaries).map(item => item.field), ['receipt', 'ock']);
});

test('Base64 envelope matching requires full canaries and does not decode recursively', () => {
  for (const index of [0, 31, 63]) {
    const nearReceipt = { ...receipt, ock: `${receipt.ock.slice(0, index)}0${receipt.ock.slice(index + 1)}` };
    const capture = new Capture('telemetry_body');
    capture.append(Buffer.from(JSON.stringify({ receipt: nearReceipt })).toString('base64'));
    assert.deepEqual(capture.findings(receiptCanaries), []);
  }
  const encoded = Buffer.from(JSON.stringify({ receipt })).toString('base64');
  const nested = new Capture('telemetry_body');
  nested.append(Buffer.from(encoded).toString('base64'));
  assert.deepEqual(nested.findings(receiptCanaries), []);
});

test('Base64 token matching rejects noncanonical padding and incomplete captured values', () => {
  const value = 'private memo /+a';
  const encoded = Buffer.from(value).toString('base64');
  assert.ok(encoded.endsWith('YQ=='));
  for (const invalid of [`${encoded}=`, `${encoded.slice(0, -4)}YR==`, encoded.slice(0, -1)]) {
    const capture = new Capture('telemetry_body');
    capture.append(invalid);
    assert.deepEqual(capture.findings([{ name: 'memo', value }]), []);
  }
  const capture = new Capture('telemetry_body', encoded.length);
  capture.append(encoded.slice(0, -4));
  capture.append(encoded.slice(-4) + 'overflow');
  assert.equal(capture.overflow, true);
  assert.deepEqual(capture.findings([{ name: 'memo', value }]), []);
});

test('UTF-8 canaries match raw, URI and canonical Base64 without accepting near matches', () => {
  const value = 'private memo 雪 🛡️ café /+';
  const canaries = [{ name: 'memo', value }];
  for (let prefix = 0; prefix < 3; prefix++) {
    for (let suffix = 0; suffix < 3; suffix++) {
      const capture = new Capture('telemetry_body');
      capture.append(`${value}|${encodeURIComponent(value)}|${Buffer.from(' '.repeat(prefix) + value + ' '.repeat(suffix)).toString('base64')}`);
      assert.deepEqual(capture.findings(canaries).map(item => item.encoding), ['raw', 'uri', 'base64']);
    }
  }
  for (const near of [value.slice(0, -1), value.replace('雪', '雨'), value.replace('café', 'cafe\u0301')]) {
    const capture = new Capture('telemetry_body');
    capture.append(`${near}|${encodeURIComponent(near)}|${Buffer.from(near).toString('base64')}`);
    assert.deepEqual(capture.findings(canaries), []);
  }
});

test('native capture overflow retains earlier chunks without changing its append lifecycle', () => {
  const capture = new Capture('stdout', 8);
  capture.append('memo');
  capture.append('too large');
  capture.append('x');
  assert.equal(capture.bytes, 14);
  assert.equal(capture.overflow, true);
  assert.equal(capture.text(), 'memo');
  assert.deepEqual(capture.findings([{ name: 'memo', value: 'memo' }]), [
    { surface: 'stdout', field: 'memo', encoding: 'raw' },
  ]);
});

test('overflow, dropped observations, missing completion and nonzero child exit are incomplete', () => {
  const good = { childReady: true, childFinished: true, exitCode: 0, timedOut: false, expectedRequests: 2, observedRequests: 2, droppedRequests: 0 };
  const capture = new Capture('stdout', 4);
  capture.append('12345');
  assert.equal(evaluateCoverage(good, [capture]).status, 'incomplete');
  for (const change of [{ childReady: false }, { childFinished: false }, { exitCode: 1 }, { timedOut: true }, { observedRequests: 1 }, { droppedRequests: 1 }]) {
    assert.equal(evaluateCoverage({ ...good, ...change }, [new Capture('stdout', 100)]).status, 'incomplete');
  }
  assert.equal(evaluateCoverage(good, [new Capture('stdout', 100)]).status, 'complete');
});

test('capability disclosures remain findings even when later observations are incomplete', () => {
  const capability = 'a4'.repeat(32);
  const capture = new Capture('stdout');
  capture.append(capability);
  const findings = capture.findings([{ name: 'capability', value: capability }]);
  const coverage = evaluateCoverage({ childReady: true, childFinished: false, exitCode: 1, timedOut: false, expectedRequests: 2, observedRequests: 1, droppedRequests: 0 }, [capture]);
  const report = publicReport({ status: 'incomplete', fixtures: [{ mode: 'hardened', findings, coverage }] });
  assert.equal(report.fixtures[0].coverage.status, 'incomplete');
  assert.deepEqual(report.fixtures[0].findings, [{ surface: 'stdout', field: 'capability', encoding: 'raw' }]);
  assert.ok(!JSON.stringify(report).includes(capability));
});

test('public JSON and HTML allowlist all fields and escape hostile text', () => {
  const secret = 'TOP_SECRET_RECIPIENT_AND_RECEIPT';
  const report = publicReport({ createdAt: '2026-09-28T12:00:00.000Z', status: 'completed', native: { status: 'verified', network: 'regtest', pool: 'ironwood', blockHeight: 103, confirmations: 1, shieldedOnly: true, receipt: secret, memo: secret, recipient: secret }, checks: [{ id: 'copied_receipt', status: 'passed', detail: secret }], fixtures: [], secret });
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!renderReport(report).includes(secret));
  assert.ok(!renderReport({ ...report, status: '<script>alert(1)</script>' }).includes('<script>'));
});
