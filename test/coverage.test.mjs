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
