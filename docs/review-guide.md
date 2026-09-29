# ShieldCheck review guide

ShieldCheck helps a Zcash checkout developer catch disclosures and order-access regressions before shipping a change to logs, telemetry or receipt handling. It is entered in Core & Tooling.

The native benchmark demonstrates the reason for the tool: the same valid, fully shielded payment can reach two checkouts with different disclosure and authorization behavior. Payment verification alone cannot establish the right to claim an order.

## Inspect the working entry

1. Open the [live analyzer](https://bortlesboat.github.io/shieldcheck/). Run **Leaky**, **Corrected**, then **Incomplete**. Expect four field findings, no registered findings, and an incomplete result that retains two findings, respectively. These browser examples are synthetic.
2. Read [the recorded native comparison](https://bortlesboat.github.io/shieldcheck/#evidence). Both fixtures verify the payment. A copied receipt claims the vulnerable order; the corrected fixture denies the copy, admits the authorized holder once and rejects replay.
3. Open the [native report](https://bortlesboat.github.io/shieldcheck/examples/benchmark-report.html) and [chain evidence](../examples/chain-evidence.json), or watch the [two-minute captioned walkthrough](https://bortlesboat.github.io/shieldcheck/demo.html).

## Evidence against the rubric

The [official ZECATHON site](https://thezecathon.com/) lists four criteria under **Judges**. This mapping uses the criteria published on September 28, 2026; no numeric weights were published.

| Criterion | Available evidence | Boundary |
| --- | --- | --- |
| Privacy | Capture analysis stays in the browser or offline CLI. Exported reports contain allowlisted metadata, not canaries or capture text. Incomplete observations cannot produce a clean result. The corrected native fixture keeps order authority separate from the payment receipt. | The vulnerable fixture contains deliberate failures using disposable test data. Detection covers registered values and documented representations on supplied surfaces; it is not a privacy certification. |
| Usefulness | Developers can import their harness output or gate a test run with the CLI's nonzero failure exits. Browser and CLI use the native benchmark's disclosure detector. | An external application adapter and independent developer adoption have not been demonstrated. |
| Execution | Live interactive analyzer, a two-minute video, public MIT-licensed source and a signed release. The dated native run met 24/24 expectations with a confirmed fully shielded Ironwood regtest payment. | Browser analysis does not rerun settlement. CI tests contracts; the full native launcher was verified on Windows with Ubuntu WSL. |
| Originality | The repository's implementation history starts on September 28, 2026, during the build window. The new benchmark combines native payment verification, explicit order-access policy and disclosure checks. | It uses existing Zcash libraries and Zebra. No claim of being the first scanner or of finding a third-party vulnerability is made. |

The [source history](https://github.com/Bortlesboat/shieldcheck/commits/main/) records work begun on September 28, 2026, and the source is [MIT licensed](../LICENSE). The [signed release](https://github.com/Bortlesboat/shieldcheck/releases/tag/v0.2.0) preserves the shipped implementation and evidence hashes.

## A developer's first check

From a source checkout with Node.js 24 or later, run the supplied leaking capture:

```powershell
node src/scan-cli.mjs --input examples/capture-input.json
$LASTEXITCODE
```

Expect exit `1` and a JSON report with four field findings. Exit `1` is the expected result for this deliberately leaking example. The report omits the registered values and captured text.

To apply the check to your own checkout test:

1. Exercise the checkout with synthetic memo, receipt, recipient, outgoing-key or capability values. Register the full values as canaries using the [capture contract](capture-contract.md).
2. Export stdout, stderr and the designated telemetry URL/body observations from your harness. Declare every required surface. Mark a capture complete only when your harness actually finished collecting it; use an empty completed capture only when that surface was observed and emitted nothing.
3. Run `node src/scan-cli.mjs --input your-capture.json` as a test step. Allow only exit `0` to pass. Findings (`1`), incomplete evidence (`2`) and invalid input (`64`) must fail the step. Review the redacted report before sharing it; keep raw captures local.

The CLI accepts captures; it does not instrument an external application or prove the capture's origin or completeness. Start with your existing test harness. A ready-made external adapter remains future work.

To verify the Zcash-specific authorization boundary, follow [Run the native benchmark](../README.md#run-the-native-benchmark). It creates an isolated Zebra node and disposable test funds, then compares copied-receipt, authorized-holder and replay requests. No wallet or real funds are needed.

## Verification limits

Known matching limits, capture bounds and trust assumptions are in the [capture contract](capture-contract.md) and [benchmark documentation](benchmark.md). In particular, canonical Base64 envelopes are supported, but Base64 URL-path segments are not separately parsed. A no-findings result applies only to the registered values and completed supplied scope.

For release and CI evidence, read the [release verification guide](release.md). Full native lifecycle containment outside the documented Windows/WSL setup and use by an independent developer remain unverified.
