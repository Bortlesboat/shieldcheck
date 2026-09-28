import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { runBenchmark } from './benchmark.mjs';
import { renderReport } from './render.mjs';

const usage = 'Usage: node src/cli.mjs --native <absolute executable> --rpc-port <1..65535> --out <new report directory>\n';
const args = process.argv.slice(2);
let options;
try {
  if (args.length !== 6) throw new Error();
  const pairs = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--native', '--rpc-port', '--out'].includes(args[i]) || pairs.has(args[i])) throw new Error();
    pairs.set(args[i], args[i + 1]);
  }
  const rpcPort = Number(pairs.get('--rpc-port'));
  if (!isAbsolute(pairs.get('--native')) || !/^\d{1,5}$/.test(pairs.get('--rpc-port')) || !Number.isInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535 || !pairs.get('--out')) throw new Error();
  options = { native: pairs.get('--native'), rpcPort, out: resolve(pairs.get('--out')) };
} catch {
  process.stderr.write(usage);
  process.exitCode = 64;
}

if (options) {
  try {
    // Exclusive directory creation refuses to overwrite any earlier evidence.
    await mkdir(dirname(options.out), { recursive: true });
    await mkdir(options.out);
    const report = await runBenchmark(options);
    await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await writeFile(resolve(options.out, 'report.html'), renderReport(report), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ status: report.status, reports: ['report.json', 'report.html'] })}\n`);
    process.exitCode = { completed: 0, failed: 1, incomplete: 2 }[report.status];
  } catch {
    process.stderr.write('benchmark_output_unavailable\n');
    process.exitCode = 2;
  }
}
