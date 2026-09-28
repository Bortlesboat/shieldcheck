import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SCAN_LIMITS, scanCaptureText } from '../src/scan.mjs';

const cli = new URL('../src/scan-cli.mjs', import.meta.url);
const secret = 'PRIVATE_CANARY_雪_/+';
const input = () => ({
  schema: 'shieldcheck-capture/v1', canaries: [{ field: 'memo', value: secret }],
  requiredSurfaces: ['stdout'], captures: [{ surface: 'stdout', text: 'event completed', complete: true }],
});
const run = (args, stdin) => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { input: stdin, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, windowsHide: true });

test('CLI stdin and file input emit the exact API report without private values or filenames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shieldcheck-scan-'));
  const path = join(directory, 'PRIVATE_FILENAME.json');
  try {
    const document = input();
    document.captures[0].text = `${secret}|${Buffer.from(secret).toString('base64')}`;
    const text = JSON.stringify(document);
    await writeFile(path, text);
    for (const result of [run(['--stdin'], text), run(['--input', path])]) {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), scanCaptureText(text));
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stdout.includes('PRIVATE_FILENAME'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI exit codes distinguish no findings, findings and incomplete evidence with findings', () => {
  const document = input();
  assert.equal(run(['--stdin'], JSON.stringify(document)).status, 0);
  document.captures[0].text = secret;
  assert.equal(run(['--stdin'], JSON.stringify(document)).status, 1);
  document.captures[0].complete = false;
  const result = run(['--stdin'], JSON.stringify(document));
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).findings.length, 1);
  document.captures = [];
  assert.equal(run(['--stdin'], JSON.stringify(document)).status, 2);
});

test('CLI syntax, malformed input, read failures, invalid UTF-8 and total overflow are redacted', () => {
  const cases = [
    [[], ''],
    [['--canary', secret], ''],
    [['--stdin', '--input', 'PRIVATE_FILENAME'], ''],
    [['--input', 'PRIVATE_FILENAME_DOES_NOT_EXIST.json'], ''],
    [['--stdin'], '{"PRIVATE_LABEL":'],
    [['--stdin'], Buffer.from([0xff])],
    [['--stdin'], JSON.stringify(input()) + ' '.repeat(SCAN_LIMITS.inputBytes)],
  ];
  for (const [args, text] of cases) {
    const result = run(args, text);
    assert.equal(result.status, 64, result.stderr);
    assert.equal(JSON.parse(result.stdout).error, 'invalid_capture_input');
    assert.equal(result.stderr, 'invalid_capture_input\n');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE_'));
  }
});
