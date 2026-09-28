import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('missing report parents are created, native unavailability is inspectable, and existing evidence is never overwritten', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'shieldcheck-test-'));
  const parent = join(scratch, 'new-parent');
  const out = join(parent, 'report');
  t.after(async () => {
    for (const file of ['report.json', 'report.html']) await unlink(join(out, file));
    await rmdir(out);
    await rmdir(parent);
    await rmdir(scratch);
  });
  const args = [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--native', join(scratch, 'missing-native'), '--rpc-port', '1', '--out', out];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const first = run();
  assert.equal(first.status, 2);
  assert.equal(first.stderr, '');
  const json = await readFile(join(out, 'report.json'), 'utf8');
  const html = await readFile(join(out, 'report.html'), 'utf8');
  const report = JSON.parse(json);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.native.status, 'unavailable');
  assert.ok(report.checks.every(check => check.status === 'incomplete'));
  assert.equal(report.fixtures.length, 0);
  assert.ok(!json.includes(scratch));
  assert.ok(!html.includes(scratch));
  assert.ok(!html.includes('<script'));
  const second = run();
  assert.equal(second.status, 2);
  assert.equal(second.stderr, 'benchmark_output_unavailable\n');
  assert.equal(await readFile(join(out, 'report.json'), 'utf8'), json);
});
