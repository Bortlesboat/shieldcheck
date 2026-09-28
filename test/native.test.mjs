import assert from 'node:assert/strict';
import test from 'node:test';
import { BRANCH, GENESIS, NativeUnavailable, runJsonProcess, validateCreated, validateVerification } from '../src/native.mjs';

const receipt = { schema: 'shieldcheck-receipt/v1', network: 'regtest', pool: 'ironwood', txid: 'ab'.repeat(32), actionIndex: 0, ock: 'cd'.repeat(32) };
const expected = { recipient: 'ef'.repeat(43), amountZat: 100000, memo: 'test-only' };
const evidence = { network: 'regtest', pool: 'ironwood', genesis: GENESIS, branchId: BRANCH, txid: receipt.txid, blockHash: '12'.repeat(32), blockHeight: 103, confirmations: 1, shieldedOnly: true };

test('strict native created contract rejects unexpected fields, invoices and chain evidence', () => {
  const good = { status: 'created', receipt, expected, evidence };
  assert.equal(validateCreated(good, expected), good);
  for (const value of [{ ...good, extra: 'secret' }, { ...good, status: 'verified' }, { ...good, expected: { ...expected, memo: 'different' } }, { ...good, evidence: { ...evidence, confirmations: 0 } }, { ...good, evidence: { ...evidence, shieldedOnly: false } }, { ...good, evidence: { ...evidence, genesis: '00'.repeat(32) } }, { ...good, receipt: { ...receipt, ock: 'not hex' } }]) {
    assert.throws(() => validateCreated(value, expected), NativeUnavailable);
  }
});

test('only matched typed native status and exit code can establish verification or rejection', () => {
  assert.equal(validateVerification({ status: 'verified', evidence }, 0, receipt).status, 'verified');
  assert.equal(validateVerification({ status: 'rejected', code: 'invalid_receipt' }, 2, receipt).status, 'rejected');
  for (const [value, code] of [[{ status: 'verified', evidence }, 1], [{ status: 'rejected', code: 'invalid_receipt' }, 0], [{ status: 'rejected', code: 'native_unavailable' }, 2], [{ status: 'error', code: 'native_unavailable' }, 1], [{ status: 'unexpected', evidence }, 0], [{ status: 'verified', evidence: { ...evidence, txid: '00'.repeat(32) } }, 0], [{ status: 'rejected', code: 'invalid_input', debug: 'secret' }, 2]]) {
    assert.throws(() => validateVerification(value, code, receipt), NativeUnavailable);
  }
});

test('actual child adapter rejects malformed, oversized and timed-out native output without diagnostics', async () => {
  for (const source of ["process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('not JSON private diagnostic'))", "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('x'.repeat(70000)))", "process.stdin.resume(); process.stdin.on('end',()=>process.stderr.write('x'.repeat(70000)))"]) {
    await assert.rejects(runJsonProcess(process.execPath, ['-e', source], {}, 2000), error => error instanceof NativeUnavailable && error.message === 'native_unavailable');
  }
  await assert.rejects(runJsonProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {}, 80), NativeUnavailable);
  const response = await runJsonProcess(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({status:'rejected',code:'invalid_receipt'}));process.exitCode=2})"], {}, 2000);
  assert.equal(validateVerification(response.result, response.exitCode, receipt).status, 'rejected');
});

test('oversized native stdin is rejected before any child can execute', async () => {
  await assert.rejects(runJsonProcess(process.execPath, ['-e', "process.stdout.write('should not execute')"], { memo: 'x'.repeat(32768) }), error => error instanceof NativeUnavailable && error.message === 'native_unavailable');
});
