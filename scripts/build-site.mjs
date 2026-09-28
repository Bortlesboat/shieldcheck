import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const SITE_FILES = Object.freeze([
  'index.html', 'web/styles.css', 'web/app.mjs', 'web/samples.mjs',
  'src/scan.mjs', 'src/disclosures.mjs',
  'examples/capture-input.json', 'examples/benchmark-report.html',
  'examples/benchmark-result.json', 'examples/chain-evidence.json',
  'docs/benchmark.md', 'docs/native-contract.md', 'docs/capture-contract.md',
  'demo.html', 'web/demo.mp4', 'web/demo.vtt', 'web/demo-poster.png', 'docs/demo-script.md',
]);
const evidenceHashes = Object.freeze({
  'examples/benchmark-report.html': 'cf57f9e435154e8599bac0e6d64727c1324fcb23d9f7cc3e4d0b9ff153aa34e3',
  'examples/benchmark-result.json': '8c11eb8e6ce4c46f574e891dc5b95d90b6a778fbbf7b152156476578645e1e8e',
  'examples/chain-evidence.json': '047d1bb44c3deba860b9837bd6831f4c4ea8d097195850ff5daa7603435b812b',
});

export function within(parent, child) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

export async function buildSite({ sourceDir = root, outDir = resolve(root, 'dist') } = {}) {
  const source = await realpath(sourceDir);
  const output = resolve(outDir);
  // Only the generated dist subtree may be replaced inside the source tree.
  const unsafeOutput = destination => within(destination, source)
    || (within(source, destination) && !within(resolve(source, 'dist'), destination));
  if (unsafeOutput(output)) throw new Error('unsafe_site_output');
  const existing = await lstat(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('unsafe_site_output');
  const assets = [];
  for (const name of SITE_FILES) {
    const path = await realpath(resolve(source, ['index.html', 'demo.html'].includes(name) ? `web/${name}` : name));
    if (!within(source, path)) throw new Error('unsafe_site_source');
    const bytes = await readFile(path);
    if (evidenceHashes[name]) {
      if (createHash('sha256').update(bytes).digest('hex') !== evidenceHashes[name]) throw new Error('recorded_evidence_mismatch');
      assets.push([name, bytes]);
    } else if (['web/demo.mp4', 'web/demo-poster.png'].includes(name)) {
      assets.push([name, bytes]);
    } else {
      // Keep static output stable across Windows and Unix checkout line endings.
      assets.push([name, new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n')]);
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const resolvedOutput = resolve(await realpath(dirname(output)), relative(dirname(output), output));
  if (unsafeOutput(resolvedOutput)) throw new Error('unsafe_site_output');
  // All source validation and immutable-evidence checks finish before replacement.
  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(resolvedOutput, { recursive: true });
  for (const [name, bytes] of [...assets, ['.nojekyll', '']]) {
    const target = resolve(resolvedOutput, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node scripts/build-site.mjs');
    await buildSite();
    console.log('Built allowlisted static site in dist/.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
