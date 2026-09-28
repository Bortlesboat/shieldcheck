export const CHECKS = Object.freeze({
  native_settlement: 'The native shielded payment settled on isolated regtest',
  native_amount_mismatch: 'An incorrect invoice amount is rejected by native verification',
  native_memo_mismatch: 'An incorrect invoice memo is rejected by native verification',
  native_recipient_mismatch: 'An incorrect invoice recipient is rejected by native verification',
  native_malformed: 'Malformed native receipt input is rejected',
  native_zero_ock: 'A zeroed output disclosure key is rejected',
  native_malformed_ock: 'A malformed output disclosure key is rejected',
  native_unknown_txid: 'An unknown transaction cannot provide payment evidence',
  native_wrong_action: 'A nonexistent output action is rejected',
  native_wrong_network: 'A receipt for another network is rejected',
  native_wrong_pool: 'A receipt for another shielded pool is rejected',
  copied_receipt_vulnerable: 'The vulnerable checkout grants access to a copied valid receipt',
  copied_receipt_hardened: 'The hardened checkout denies the same copied receipt',
  copied_receipt_displaces_owner: 'The vulnerable copied claim prevents the rightful owner from claiming',
  wrong_capability: 'An incorrect capability cannot authorize a claim',
  legitimate_access: 'The legitimate capability holder obtains access',
  concurrency: 'Two concurrent legitimate claims produce exactly one fulfillment',
  replay: 'Replaying a completed claim cannot fulfill again',
  wrong_order: 'A receipt cannot satisfy a different order memo',
  modified_disclosure: 'A modified output disclosure is rejected',
  malformed_receipt: 'A malformed checkout receipt is rejected',
  vulnerable_leaks: 'The planted memo and receipt disclosures are detected',
  hardened_no_leaks: 'No registered canary appears in the hardened captured surfaces',
  complete_capture: 'Both checkout observation lifecycles completed without dropped data',
});

const statuses = new Set(['completed', 'failed', 'incomplete']);
const checkStatuses = new Set(['passed', 'failed', 'incomplete']);
const reasons = new Set(['missing_child_ready', 'missing_child_completion', 'child_failed', 'timeout', 'missing_or_extra_telemetry', 'dropped_telemetry', 'capture_overflow']);
const surfaces = new Set(['stdout', 'stderr', 'telemetry_url', 'telemetry_body']);
const fields = new Set(['memo', 'receipt', 'ock', 'recipient', 'capability']);
const encodings = new Set(['raw', 'uri', 'base64']);
const safeInteger = number => Number.isSafeInteger(number) && number >= 0 && number <= 100000000 ? number : null;

// Every persisted field is reconstructed here. Native results and HTTP responses
// must never be spread into this object, even on an error path.
export function publicReport(input) {
  const native = input.native ?? {};
  return {
    schema: 'shieldcheck-report/v1',
    createdAt: typeof input.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt) ? input.createdAt : null,
    status: statuses.has(input.status) ? input.status : 'incomplete',
    policy: 'Order access requires the capability issued at creation; the receipt alone is transferable payment evidence.',
    native: {
      status: native.status === 'verified' ? 'verified' : 'unavailable',
      network: native.network === 'regtest' ? 'regtest' : null,
      pool: native.pool === 'ironwood' ? 'ironwood' : null,
      blockHeight: safeInteger(native.blockHeight),
      confirmations: safeInteger(native.confirmations),
      shieldedOnly: native.shieldedOnly === true,
    },
    checks: (input.checks ?? []).filter(check => Object.hasOwn(CHECKS, check.id)).map(check => ({ id: check.id, status: checkStatuses.has(check.status) ? check.status : 'incomplete' })),
    fixtures: (input.fixtures ?? []).filter(fixture => ['vulnerable', 'hardened'].includes(fixture.mode)).map(fixture => ({
      mode: fixture.mode,
      fulfillments: safeInteger(fixture.fulfillments),
      findings: (fixture.findings ?? []).filter(finding => surfaces.has(finding.surface) && fields.has(finding.field) && encodings.has(finding.encoding)).map(finding => ({ surface: finding.surface, field: finding.field, encoding: finding.encoding })),
      coverage: {
        status: fixture.coverage?.status === 'complete' ? 'complete' : 'incomplete',
        reasons: (fixture.coverage?.reasons ?? []).filter(reason => reasons.has(reason)),
        observedRequests: safeInteger(fixture.coverage?.observedRequests),
        expectedRequests: safeInteger(fixture.coverage?.expectedRequests),
      },
    })),
    coverage: {
      inspected: ['Owned checkout child stdout and stderr', 'Designated telemetry sink URLs and request bodies', 'Registered canaries in raw, URI and Base64 representations'],
      uninspected: ['Other network destinations and system processes', 'Browser storage, extensions and browser traffic', 'Unknown encodings, hashes and fragments', 'Third-party applications and production deployments'],
    },
    limitations: ['Deliberately vulnerable local fixture; no claim of a vulnerability in another project.', 'Disposable regtest settlement only; no mainnet or public testnet payment.', 'No privacy score or certification. A clean observation covers only the listed surfaces and encodings.', 'The selected-output receipt is a fixture format, not a payer identity proof or a standardized receipt protocol.'],
  };
}

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderReport(input) {
  const report = publicReport(input);
  const headline = { completed: 'A valid payment can still leak.', failed: 'A benchmark expectation failed.', incomplete: 'Evidence is incomplete.' }[report.status];
  const summary = { completed: 'The planted regression was reproduced, and the corrected checkout passed the observed controls.', failed: 'Review the failed control below. This run did not reproduce the full expected result.', incomplete: 'At least one required observation is missing. No clean or secure result is claimed.' }[report.status];
  const fixture = mode => report.fixtures.find(item => item.mode === mode);
  const cards = ['vulnerable', 'hardened'].map(mode => {
    const item = fixture(mode);
    return `<article class="fixture ${mode}"><p class="eyebrow">${mode === 'vulnerable' ? '01 / Deliberately vulnerable' : '02 / Corrected control'}</p><h2>${mode === 'vulnerable' ? 'Payment evidence alone' : 'Payment + order authority'}</h2><p>${mode === 'vulnerable' ? 'Accepts a copied receipt and sends invoice details to its own telemetry sink.' : 'Requires a secret order capability and a fresh challenge before one-time fulfillment.'}</p><dl><div><dt>Canary findings</dt><dd>${item ? item.findings.length : '—'}</dd></div><div><dt>Fulfillments</dt><dd>${item?.fulfillments ?? '—'}</dd></div><div><dt>Capture</dt><dd>${escape(item?.coverage.status ?? 'incomplete')}</dd></div></dl>${item?.findings.length ? `<ul class="findings">${item.findings.map(finding => `<li><strong>${escape(finding.field)}</strong> · ${escape(finding.surface.replaceAll('_', ' '))} · ${escape(finding.encoding)}</li>`).join('')}</ul>` : '<p class="muted">No registered canary was found in available captured data. The coverage result determines whether that observation is complete.</p>'}</article>`;
  }).join('');
  const rows = Object.entries(CHECKS).map(([id, label]) => {
    const status = report.checks.find(check => check.id === id)?.status ?? 'incomplete';
    return `<tr><td>${escape(label)}</td><td><span class="state ${status}">${status}</span></td></tr>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ShieldCheck · Checkout benchmark</title><style>
:root{color-scheme:light;--ink:#162422;--muted:#506460;--paper:#f3f4ef;--line:#ced6ce;--green:#0d664c;--red:#994029}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:48px 28px 72px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:24px}.brand{font-size:22px;font-weight:800;letter-spacing:-.7px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:1.4px;text-transform:uppercase}.meta,.muted{color:var(--muted);font-size:14px}.hero{padding:54px 0 34px;max-width:800px}h1{font-size:clamp(36px,6vw,64px);line-height:1.04;letter-spacing:-2.6px;margin:14px 0 22px}h2{font-size:24px;letter-spacing:-.7px;line-height:1.2;margin:12px 0}.hero>p{font-size:19px;max-width:690px}.status{display:inline-block;padding:5px 10px;background:#d8eadd;color:var(--green);font-weight:700;font-size:13px}.status.failed,.status.incomplete{background:#f4dfcf;color:var(--red)}.chain{display:flex;flex-wrap:wrap;gap:18px 30px;border-block:1px solid var(--line);padding:20px 0;margin-bottom:30px}.chain span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px}.chain strong{font-size:17px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.fixture{padding:26px;background:#fff;border:1px solid var(--line);border-top:4px solid var(--green)}.fixture.vulnerable{border-top-color:var(--red)}.fixture p{max-width:440px}.fixture dl{display:flex;flex-wrap:wrap;gap:24px;padding:16px 0;border-block:1px solid var(--line);margin:24px 0}.fixture dt{font-size:12px;color:var(--muted)}.fixture dd{margin:3px 0 0;font-size:19px;font-weight:700}.findings{padding-left:18px;font-size:14px}section{margin-top:42px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:13px 0;text-align:left;border-bottom:1px solid var(--line)}td:last-child,th:last-child{text-align:right;padding-left:16px}.state{font-size:12px;font-weight:750;color:var(--green)}.state.failed,.state.incomplete{color:var(--red)}.coverage{padding:25px;border:1px solid var(--line);background:#e8ede5}.coverage ul{padding-left:18px;margin-bottom:0}.policy{padding:18px 22px;border-left:3px solid var(--ink);background:#e6ebe3}.footer{margin-top:36px;border-top:1px solid var(--line);padding-top:18px;font-size:13px;color:var(--muted)}@media(max-width:680px){main{padding:24px 18px 48px}.grid{grid-template-columns:1fr}header{align-items:flex-start;gap:20px}.meta{text-align:right;font-size:12px}.fixture{padding:22px}.hero{padding-top:38px}h1{letter-spacing:-1.6px}.fixture dl{gap:20px}td{vertical-align:top}}
</style></head><body><main><header><div class="brand">ShieldCheck<span aria-hidden="true"> /</span></div><div class="meta">LOCAL CHECKOUT BENCHMARK<br>${escape(report.createdAt ?? 'Time unavailable')}</div></header><div class="hero"><span class="status ${report.status}">${report.status === 'completed' ? 'Expected regression reproduced' : report.status}</span><h1>${headline}</h1><p>${summary}</p></div><div class="chain"><div><span>Native settlement</span><strong>${report.native.status}</strong></div><div><span>Network / pool</span><strong>${escape(report.native.network ?? 'unavailable')} / ${escape(report.native.pool ?? 'unavailable')}</strong></div><div><span>Block / confirmations</span><strong>${report.native.blockHeight ?? '—'} / ${report.native.confirmations ?? '—'}</strong></div><div><span>Transparent bundle</span><strong>${report.native.shieldedOnly ? 'Absent, verified' : 'Unverified'}</strong></div></div><p class="policy">${escape(report.policy)}</p><div class="grid">${cards}</div><section><p class="eyebrow">Controls</p><h2>What this run established</h2><table><thead><tr><th scope="col">Benchmark expectation</th><th scope="col">Result</th></tr></thead><tbody>${rows}</tbody></table></section><section class="coverage"><p class="eyebrow">Observation boundary</p><div class="grid"><div><h2>Inspected</h2><ul>${report.coverage.inspected.map(item => `<li>${escape(item)}</li>`).join('')}</ul></div><div><h2>Outside this run</h2><ul>${report.coverage.uninspected.map(item => `<li>${escape(item)}</li>`).join('')}</ul></div></div></section><footer class="footer">${report.limitations.map(item => `<p>${escape(item)}</p>`).join('')}<p>Reports omit invoice memos, recipients, output keys, order capabilities and receipt payloads.</p></footer></main></body></html>`;
}
