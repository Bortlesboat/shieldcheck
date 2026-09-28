import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSite } from '../scripts/build-site.mjs';
import { createSiteServer } from '../scripts/serve-site.mjs';
import { scanCaptureText } from '../src/scan.mjs';
import { PRESETS } from '../web/samples.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const approved = [
  '.nojekyll', 'index.html', 'web/app.mjs', 'web/samples.mjs', 'web/styles.css',
  'src/scan.mjs', 'src/disclosures.mjs', 'examples/capture-input.json',
  'examples/benchmark-report.html', 'examples/benchmark-result.json', 'examples/chain-evidence.json',
  'docs/benchmark.md', 'docs/native-contract.md', 'docs/capture-contract.md',
  'demo.html', 'web/demo.mp4', 'web/demo.vtt', 'web/demo-poster.png', 'docs/demo-script.md',
].sort();
const evidenceHashes = {
  'examples/benchmark-report.html': 'cf57f9e435154e8599bac0e6d64727c1324fcb23d9f7cc3e4d0b9ff153aa34e3',
  'examples/benchmark-result.json': '8c11eb8e6ce4c46f574e891dc5b95d90b6a778fbbf7b152156476578645e1e8e',
  'examples/chain-evidence.json': '047d1bb44c3deba860b9837bd6831f4c4ea8d097195850ff5daa7603435b812b',
};

test('published video and poster retain binary bytes and captions remain available', async t => {
  const directory = await temporary(t);
  await buildSite({ outDir: join(directory, 'dist') });
  for (const path of ['web/demo.mp4', 'web/demo-poster.png']) {
    assert.deepEqual(await readFile(join(directory, 'dist', path)), await readFile(join(root, path)));
  }
  assert.match(await readFile(join(directory, 'dist/web/demo.vtt'), 'utf8'), /^WEBVTT/);
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shieldcheck-site-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    result.push(...entry.isDirectory() ? await files(join(directory, entry.name), `${name}/`) : [name]);
  }
  return result.sort();
}

async function sourceFixture(directory) {
  for (const path of approved.filter(path => path !== '.nojekyll')) {
    const source = ['index.html', 'demo.html'].includes(path) ? `web/${path}` : path;
    await mkdir(dirname(join(directory, source)), { recursive: true });
    await cp(join(root, source), join(directory, source));
  }
}

test('browser presets use the real scanner and retain findings when coverage is incomplete', () => {
  const leaky = scanCaptureText(PRESETS.leaky.text);
  assert.equal(leaky.status, 'findings');
  assert.deepEqual(leaky.findings, [
    { surface: 'stdout', field: 'memo', encoding: 'raw' },
    { surface: 'telemetry_url', field: 'memo', encoding: 'uri' },
    { surface: 'telemetry_body', field: 'receipt', encoding: 'raw' },
    { surface: 'telemetry_body', field: 'receipt', encoding: 'base64' },
  ]);
  assert.equal(scanCaptureText(PRESETS.corrected.text).status, 'no_findings');
  const incomplete = scanCaptureText(PRESETS.incomplete.text);
  assert.equal(incomplete.status, 'incomplete');
  assert.ok(incomplete.findings.length > 0);
  assert.ok(incomplete.coverage.reasons.includes('declared_incomplete'));
  for (const preset of Object.values(PRESETS)) {
    const report = scanCaptureText(preset.text);
    assert.equal(report.provenance, 'unverified');
    assert.equal(report.nativeSettlement, 'not_evaluated');
    for (const { value } of JSON.parse(preset.text).canaries) assert.ok(!JSON.stringify(report).includes(value));
  }
});

test('build publishes exactly the approved assets, preserving recorded evidence byte for byte', async t => {
  const directory = await temporary(t);
  const sourceDir = join(directory, 'source');
  await sourceFixture(sourceDir);
  await mkdir(join(sourceDir, '.local'), { recursive: true });
  await writeFile(join(sourceDir, '.local/private.txt'), 'must not publish');
  await writeFile(join(sourceDir, 'src/checkout.mjs'), 'must not publish');
  const outDir = join(directory, 'dist');
  await buildSite({ sourceDir, outDir });
  assert.deepEqual(await files(outDir), approved);
  for (const [path, hash] of Object.entries(evidenceHashes)) {
    const bytes = await readFile(join(outDir, path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    assert.deepEqual(bytes, await readFile(join(root, path)));
  }
  await writeFile(join(outDir, 'stale-private.txt'), 'must not survive rebuild');
  await buildSite({ sourceDir, outDir });
  assert.deepEqual(await files(outDir), approved);
});

test('build is identical across mutable text line endings and repeated runs', async t => {
  const directory = await temporary(t);
  const sourceDir = join(directory, 'source');
  await sourceFixture(sourceDir);
  const first = join(directory, 'first/dist');
  const second = join(directory, 'second/dist');
  await buildSite({ sourceDir, outDir: first });
  for (const path of approved.filter(path => path !== '.nojekyll' && !evidenceHashes[path] && !/\.(mp4|png)$/.test(path))) {
    const source = join(sourceDir, ['index.html', 'demo.html'].includes(path) ? `web/${path}` : path);
    await writeFile(source, (await readFile(source, 'utf8')).replace(/\r?\n/g, '\r\n'));
  }
  await buildSite({ sourceDir, outDir: second });
  for (const path of approved) assert.deepEqual(await readFile(join(first, path)), await readFile(join(second, path)), path);
});

test('changed recorded evidence fails the build before existing output is touched', async t => {
  const directory = await temporary(t);
  const sourceDir = join(directory, 'source');
  const outDir = join(directory, 'dist');
  await sourceFixture(sourceDir);
  await mkdir(outDir);
  await writeFile(join(outDir, 'sentinel'), 'keep');
  for (const path of Object.keys(evidenceHashes)) {
    const original = await readFile(join(sourceDir, path));
    await writeFile(join(sourceDir, path), Buffer.concat([original, Buffer.from('\n')]));
    await assert.rejects(buildSite({ sourceDir, outDir }), /recorded_evidence_mismatch/);
    assert.equal(await readFile(join(outDir, 'sentinel'), 'utf8'), 'keep');
    await writeFile(join(sourceDir, path), original);
  }
});

test('build refuses to replace the source, an ancestor, or a linked output directory', async t => {
  const directory = await temporary(t);
  const sourceDir = join(directory, 'source');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'sentinel'), 'keep');
  for (const outDir of [sourceDir, directory]) {
    await assert.rejects(buildSite({ sourceDir, outDir }), /unsafe_site_output/);
    assert.equal(await readFile(join(sourceDir, 'sentinel'), 'utf8'), 'keep');
  }
  const outDir = join(directory, 'dist');
  await symlink(sourceDir, outDir, 'junction');
  await assert.rejects(buildSite({ sourceDir, outDir }), /unsafe_site_output/);
  assert.equal(await readFile(join(sourceDir, 'sentinel'), 'utf8'), 'keep');
});

test('page and module references resolve under a repository subpath with an early restrictive CSP', async t => {
  const outDir = join(await temporary(t), 'dist');
  await buildSite({ outDir });
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(policy);
  assert.ok(html.indexOf(policy[0]) < html.indexOf('<link'));
  assert.ok(html.indexOf(policy[0]) < html.indexOf('<script'));
  for (const directive of ["default-src 'none'", "connect-src 'none'", "script-src 'self'", "form-action 'none'", "base-uri 'none'"]) assert.ok(policy[1].includes(directive));
  assert.ok(!policy[1].includes('unsafe-inline'));
  const origin = 'http://127.0.0.1:4173';
  const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => new URL(match[1], `${origin}/shieldcheck/`));
  for (const path of ['web/app.mjs', 'web/samples.mjs', 'src/scan.mjs', 'src/disclosures.mjs']) {
    const source = await readFile(join(outDir, path), 'utf8');
    urls.push(...[...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => new URL(match[1], `${origin}/shieldcheck/${path}`)));
  }
  for (const url of urls) {
    if (url.href === 'https://github.com/Bortlesboat/shieldcheck') continue;
    assert.equal(url.origin, origin);
    assert.ok(url.pathname.startsWith('/shieldcheck/'));
    const path = url.pathname.slice('/shieldcheck/'.length) || 'index.html';
    assert.ok(approved.includes(path), path);
    await readFile(join(outDir, path));
  }
});

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString() }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('loopback server serves the built subpath and rejects traversal, source files and mutations', async t => {
  const directory = await temporary(t);
  const outDir = join(directory, 'dist');
  await buildSite({ outDir });
  await writeFile(join(directory, 'secret.txt'), 'private');
  await writeFile(join(outDir, 'unapproved.txt'), 'private');
  const server = createSiteServer({ directory: outDir, basePath: '/shieldcheck/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1');
  assert.equal((await get(port, '/shieldcheck/')).status, 200);
  assert.match((await get(port, '/shieldcheck/web/app.mjs')).headers['content-type'], /javascript/);
  assert.equal((await get(port, '/shieldcheck/examples/benchmark-report.html')).body, await readFile(join(root, 'examples/benchmark-report.html'), 'utf8'));
  const head = await get(port, '/shieldcheck/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  for (const path of ['/shieldcheck/../secret.txt', '/shieldcheck/%2e%2e/secret.txt', '/shieldcheck/%2e%2e%5csecret.txt', '/shieldcheck/%00', '/shieldcheck/%zz', '/shieldcheck/unapproved.txt', '/shieldcheck/src/checkout.mjs', '/shieldcheck/package.json', '/shieldcheck/.local/private.txt', '/index.html']) {
    const response = await get(port, path);
    assert.ok([400, 404].includes(response.status), path);
    assert.ok(!response.body.includes('private'));
  }
  assert.equal((await get(port, '/shieldcheck/', 'POST')).status, 405);
});
