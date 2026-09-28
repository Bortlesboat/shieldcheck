import { spawn } from 'node:child_process';

export const GENESIS = '029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327';
export const BRANCH = '37a5165b';
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export class NativeUnavailable extends Error {
  constructor() { super('native_unavailable'); this.name = 'NativeUnavailable'; }
}

export function validReceipt(receipt) {
  return exactKeys(receipt, ['schema', 'network', 'pool', 'txid', 'actionIndex', 'ock'])
    && receipt.schema === 'shieldcheck-receipt/v1' && receipt.network === 'regtest' && receipt.pool === 'ironwood'
    && hex(receipt.txid, 64) && hex(receipt.ock, 64) && Number.isSafeInteger(receipt.actionIndex)
    && receipt.actionIndex >= 0 && receipt.actionIndex < 1024;
}

export function validExpected(expected) {
  return exactKeys(expected, ['recipient', 'amountZat', 'memo']) && hex(expected.recipient, 86)
    && Number.isSafeInteger(expected.amountZat) && expected.amountZat > 0
    && typeof expected.memo === 'string' && Buffer.byteLength(expected.memo) <= 512;
}

export function validEvidence(evidence, txid) {
  return exactKeys(evidence, ['network', 'pool', 'genesis', 'branchId', 'txid', 'blockHash', 'blockHeight', 'confirmations', 'shieldedOnly'])
    && evidence.network === 'regtest' && evidence.pool === 'ironwood' && evidence.genesis === GENESIS && evidence.branchId === BRANCH
    && hex(evidence.txid, 64) && evidence.txid === txid && hex(evidence.blockHash, 64)
    && Number.isSafeInteger(evidence.blockHeight) && evidence.blockHeight > 0
    && Number.isSafeInteger(evidence.confirmations) && evidence.confirmations >= 1 && evidence.shieldedOnly === true;
}

export function validateCreated(result, input) {
  if (!exactKeys(result, ['status', 'receipt', 'expected', 'evidence']) || result.status !== 'created'
    || !validReceipt(result.receipt) || !validExpected(result.expected) || !validEvidence(result.evidence, result.receipt.txid)
    || result.expected.memo !== input.memo || result.expected.amountZat !== input.amountZat) throw new NativeUnavailable();
  return result;
}

export function validateVerification(result, exitCode, receipt) {
  if (exitCode === 0 && exactKeys(result, ['status', 'evidence']) && result.status === 'verified' && validEvidence(result.evidence, receipt?.txid)) return result;
  if (exitCode === 2 && exactKeys(result, ['status', 'code']) && result.status === 'rejected' && ['invalid_receipt', 'invalid_input'].includes(result.code)) return result;
  throw new NativeUnavailable();
}

export async function runJsonProcess(executable, args, input, timeoutMs = 30000) {
  let serialized;
  try {
    serialized = JSON.stringify(input);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 32768) throw new NativeUnavailable();
  } catch { throw new NativeUnavailable(); }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', bytes = 0, failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill();
      reject(new NativeUnavailable());
    };
    const timer = setTimeout(fail, timeoutMs);
    for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) return fail();
        if (retain) stdout += chunk.toString('utf8');
      });
    }
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', exitCode => {
      clearTimeout(timer);
      if (failed) return;
      try { resolve({ result: JSON.parse(stdout), exitCode }); } catch { reject(new NativeUnavailable()); }
    });
    child.stdin.end(serialized);
  });
}

export async function createPayment(executable, input) {
  const { result, exitCode } = await runJsonProcess(executable, ['pay'], input, 300000);
  if (exitCode !== 0) throw new NativeUnavailable();
  return validateCreated(result, input);
}

export async function verifyPayment(executable, input) {
  const { result, exitCode } = await runJsonProcess(executable, ['verify'], input, 30000);
  return validateVerification(result, exitCode, input.receipt);
}
