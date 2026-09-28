import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { Capture } from '../src/coverage.mjs';
import { CAPTURE_FIELDS, CAPTURE_SURFACES, SCAN_LIMITS, scanCaptureText, scanCaptures } from '../src/scan.mjs';

const secret = 'synthetic memo 雪 🛡️ /+';
const input = () => ({
  schema: 'shieldcheck-capture/v1',
  canaries: [{ field: 'memo', value: secret }],
  requiredSurfaces: ['stdout'],
  captures: [{ surface: 'stdout', text: 'event completed', complete: true }],
});
const invalid = document => {
  const report = scanCaptures(document);
  assert.equal(report.status, 'invalid');
  assert.equal(report.error, 'invalid_capture_input');
  assert.deepEqual(report.findings, []);
  assert.equal(report.coverage.status, 'incomplete');
  return report;
};

test('supplied captures produce a separate redacted report with unverified provenance', () => {
  const document = input();
  document.captures[0].text = `${secret}|${encodeURIComponent(secret)}|${Buffer.from(secret).toString('base64')}`;
  const report = scanCaptures(document);
  assert.deepEqual(report, {
    schema: 'shieldcheck-scan-report/v1', status: 'findings', provenance: 'unverified', nativeSettlement: 'not_evaluated',
    findings: ['raw', 'uri', 'base64'].map(encoding => ({ surface: 'stdout', field: 'memo', encoding })),
    coverage: { status: 'declared_complete', reasons: [], requiredSurfaces: ['stdout'], suppliedSurfaces: ['stdout'] },
  });
  assert.deepEqual(scanCaptureText(JSON.stringify(document)), report);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal(scanCaptures(input()).status, 'no_findings');
});

test('missing or declared incomplete surfaces retain observed findings', () => {
  for (const cause of ['missing', 'declared']) {
    const document = input();
    document.captures[0].text = secret;
    if (cause === 'missing') document.requiredSurfaces.push('stderr');
    else document.captures[0].complete = false;
    const report = scanCaptures(document);
    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.findings, [{ surface: 'stdout', field: 'memo', encoding: 'raw' }]);
    assert.deepEqual(report.coverage.reasons, [cause === 'missing' ? 'missing_required_surface' : 'declared_incomplete']);
  }
  const document = input();
  document.captures = [];
  assert.equal(scanCaptures(document).status, 'incomplete');
});

test('capture limits count UTF-8 bytes, retain prefix findings and ignore discarded suffixes', () => {
  const document = input();
  const prefix = secret + '|';
  const retained = prefix + 'x'.repeat(SCAN_LIMITS.captureBytes - Buffer.byteLength(prefix));
  document.canaries.push({ field: 'receipt', value: 'suffix-only-canary' });
  document.captures[0].text = retained;
  assert.equal(scanCaptures(document).status, 'findings');
  document.captures[0].text += '|suffix-only-canary';
  const report = scanCaptures(document);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.coverage.reasons, ['capture_overflow']);
  assert.deepEqual(report.findings, [{ surface: 'stdout', field: 'memo', encoding: 'raw' }]);
  document.captures[0].text = '雪'.repeat(Math.floor(SCAN_LIMITS.captureBytes / 3) + 1);
  assert.equal(scanCaptures(document).status, 'incomplete');
});

test('overflow truncation does not invent a UTF-8 replacement-character finding', () => {
  const document = input();
  document.canaries = [{ field: 'memo', value: '\ufffd' }];
  document.captures[0].text = '.'.repeat(SCAN_LIMITS.captureBytes - 1) + '雪';
  assert.deepEqual(scanCaptures(document).findings, []);
});

test('structure, enums, duplicate names, text types and canary bounds fail generically', () => {
  const changes = [
    doc => { doc.schema = 'other'; },
    doc => { doc.extra = 'PRIVATE_LABEL'; },
    doc => { delete doc.requiredSurfaces; },
    doc => { doc.requiredSurfaces = []; },
    doc => { doc.requiredSurfaces = ['stdout', 'stdout']; },
    doc => { doc.requiredSurfaces = ['PRIVATE_LABEL']; },
    doc => { doc.canaries = []; },
    doc => { doc.canaries.push({ ...doc.canaries[0] }); },
    doc => { doc.canaries[0].field = 'PRIVATE_LABEL'; },
    doc => { doc.canaries[0].value = ''; },
    doc => { doc.canaries[0].value = '雪'.repeat(Math.floor(SCAN_LIMITS.canaryBytes / 3) + 1); },
    doc => { doc.canaries[0].value = '\ud800'; },
    doc => { doc.canaries[0].value = 42; },
    doc => { doc.canaries[0].label = 'PRIVATE_LABEL'; },
    doc => { doc.captures[0].surface = 'PRIVATE_LABEL'; },
    doc => { doc.captures[0].complete = 'true'; },
    doc => { delete doc.captures[0].complete; },
    doc => { doc.captures[0].text = null; },
    doc => { doc.captures[0].text = '\udfff'; },
    doc => { doc.captures[0].label = 'PRIVATE_LABEL'; },
    doc => { doc.captures.push({ ...doc.captures[0] }); },
    doc => { doc.captures = Array.from({ length: 5 }, () => ({ ...doc.captures[0] })); },
  ];
  const expected = invalid(null);
  for (const change of changes) {
    const document = input();
    change(document);
    assert.deepEqual(invalid(document), expected);
  }
  for (const document of [[], true, 3, 'PRIVATE_LABEL', undefined]) assert.deepEqual(invalid(document), expected);
  assert.equal(CAPTURE_FIELDS.length, 5);
  assert.equal(CAPTURE_SURFACES.length, 4);
});

test('direct object calls reject accessors, holes, symbols and non-JSON prototypes', () => {
  const documents = [];
  for (const mutation of [
    doc => Object.setPrototypeOf(doc, { toJSON: () => input() }),
    doc => Object.setPrototypeOf(doc.captures, null),
    doc => Object.defineProperty(doc.captures[0], 'text', { get() { throw new Error('PRIVATE_LABEL'); } }),
    doc => { doc.canaries[Symbol('PRIVATE_LABEL')] = 1; },
    doc => { delete doc.canaries[0]; },
    doc => { doc.captures.extra = 'PRIVATE_LABEL'; },
  ]) {
    const document = input();
    mutation(document);
    documents.push(document);
  }
  for (const document of documents) invalid(document);
});

test('malformed JSON and total input overflow have the same redacted failure', () => {
  const expected = invalid(null);
  for (const text of [
    '{"PRIVATE_LABEL":',
    '{"schema":"shieldcheck-capture/v1","schema":"shieldcheck-capture/v1"}',
    JSON.stringify(input()) + ' '.repeat(SCAN_LIMITS.inputBytes),
    null,
  ]) assert.deepEqual(scanCaptureText(text), expected);
  const document = input();
  document.captures[0].text = secret + 'x'.repeat(SCAN_LIMITS.inputBytes);
  assert.deepEqual(invalid(document), expected);
});

test('portable detector agrees with the native owner without Node globals', async () => {
  const source = await readFile(new URL('../src/disclosures.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('Buffer'));
  const context = vm.createContext({ TextEncoder, URL, URLSearchParams, atob, btoa });
  const findDisclosures = vm.runInContext(source.replace('export function findDisclosures', 'function findDisclosures') + '\nfindDisclosures;', context);
  const values = [secret, 'private memo /+a', 'receipt-key:abcd0123'];
  for (const surface of CAPTURE_SURFACES) {
    for (const value of values) {
      const canaries = [{ name: 'memo', value }];
      const serializations = [value, encodeURIComponent(value), new URLSearchParams({ memo: value }).toString(), new URL(`http://127.0.0.1/?memo=${value}`).search];
      for (let prefix = 0; prefix < 3; prefix++) for (let suffix = 0; suffix < 3; suffix++) {
        serializations.push(Buffer.from(' '.repeat(prefix) + value + ' '.repeat(suffix)).toString('base64'));
      }
      for (const captured of serializations) {
        const capture = new Capture(surface);
        capture.append(captured);
        assert.deepEqual(JSON.parse(JSON.stringify(findDisclosures(captured, surface, canaries))), capture.findings(canaries));
      }
    }
  }
});

test('findings and coverage surface order are stable across caller ordering', () => {
  const document = input();
  document.canaries.push({ field: 'receipt', value: 'synthetic receipt' });
  document.requiredSurfaces.push('telemetry_body');
  document.captures.push({ surface: 'telemetry_body', text: `${secret}|synthetic receipt`, complete: true });
  document.captures[0].text = `${secret}|synthetic receipt`;
  const report = scanCaptures(document);
  document.canaries.reverse();
  document.requiredSurfaces.reverse();
  document.captures.reverse();
  assert.deepEqual(scanCaptures(document), report);
});
