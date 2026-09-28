import { createReadStream } from 'node:fs';
import { SCAN_LIMITS, scanCaptureText } from './scan.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node src/scan-cli.mjs --input <capture.json> | --stdin\n';

async function readInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > SCAN_LIMITS.inputBytes) throw new Error('invalid_capture_input');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(usage);
} else {
  let report;
  try {
    let stream;
    if (args.length === 1 && args[0] === '--stdin') stream = process.stdin;
    else if (args.length === 2 && args[0] === '--input' && args[1]) stream = createReadStream(args[1]);
    else throw new Error('invalid_capture_input');
    report = scanCaptureText(await readInput(stream));
  } catch { report = scanCaptureText(null); }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'invalid') process.stderr.write('invalid_capture_input\n');
  process.exitCode = { no_findings: 0, findings: 1, incomplete: 2, invalid: 64 }[report.status];
}
