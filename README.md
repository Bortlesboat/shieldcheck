# ShieldCheck

**A valid shielded payment can still end in a leaky checkout.**

[Try the live analyzer](https://bortlesboat.github.io/shieldcheck/) · [Watch the two-minute demo](https://bortlesboat.github.io/shieldcheck/demo.html)

ShieldCheck checks the application boundary around a shielded payment. Its browser analyzer and offline CLI find registered synthetic test values in supplied captures, using the same disclosure detector as its native benchmark.

The separate native benchmark reproduces that gap with a real Zcash regtest payment. It compares a deliberately vulnerable checkout with a corrected one, then produces a redacted report of settlement, receipt validation, order access and observed disclosures.

The central test is simple: copy a valid payment receipt and try to claim the order before its owner. Both checkouts verify the same native payment. The vulnerable checkout grants access; the corrected checkout requires the separate order capability and denies the copy.

The native benchmark uses our own disposable fixtures. Supplied-capture analysis does not observe an application or verify native settlement. Neither result is a privacy certification.

## Inspect a supplied capture

Requires Node.js 24 or later; there are no JavaScript package dependencies. Build and open the local browser analyzer:

```powershell
npm run build:site
npm run serve:site
```

Open `http://127.0.0.1:4173/`. Start with the leaky, corrected or incomplete synthetic example, then select **Run local analysis**. You can edit the JSON, import a local UTF-8 JSON file, and download a redacted result. Editing, importing, changing examples or resetting clears the previous result. Analysis stays in the browser; the page has no telemetry, remote assets or persistent storage.

The input limit is 1 MiB, checked before reading an imported file. Up to five canaries and four capture surfaces are supported. Missing or incomplete captures remain incomplete even when they contain findings; a capture above 128 KiB retains findings only from its bounded prefix. Report provenance is always unverified, capture completeness is only the caller's declaration, and native settlement is not evaluated.

Use the same interface from the command line:

```powershell
node src/scan-cli.mjs --input examples/capture-input.json
node my-capture-exporter.mjs | node src/scan-cli.mjs --stdin
```

The CLI emits redacted JSON. Exit `0` means no registered findings in the supplied declared-complete scope; `1` means findings, `2` means incomplete evidence, and `64` means invalid input. A result contains allowlisted finding metadata and coverage status, never canary values or captured text. Read the [capture contract](docs/capture-contract.md) for the exact schema, limits and matching boundary.

The static build copies an explicit allowlist into ignored `dist/`, checks the recorded evidence hashes, and preserves those original files byte for byte. It excludes the native runner, vulnerable checkout, node state and runtime reports. To check repository-subpath hosting locally:

```powershell
node scripts/serve-site.mjs --base-path /shieldcheck/
```

Open `http://127.0.0.1:4173/shieldcheck/`. The preview server binds only to loopback and serves approved files from the built site.

## Recorded native evidence

[Open the recorded report](examples/benchmark-report.html) · [JSON result](examples/benchmark-result.json) · [Disposable chain evidence](examples/chain-evidence.json)

The September 28, 2026 native run met all 24 benchmark expectations at block 103 with one confirmation in the Ironwood regtest pool. It detected four field findings in the vulnerable fixture and zero in the corrected fixture, copied-receipt acceptance in the vulnerable fixture, and denial plus one-time authorized access in the corrected fixture.

The original recorded report has been visually verified on desktop and mobile. A fresh native rerun after the shared-detector extraction also met all 24 expectations and preserved the recorded behavior. These historical artifacts remain unchanged; browser analysis neither reruns native settlement nor changes the recorded result.

Recorded implementation: `21478fcc87de3c6dddf878f5c910cf5b4419fe9e`. The chain-evidence file pins the native binary and JSON report hashes for this run.

## Run the native benchmark

The verified launcher targets Windows with PowerShell 7.4+, Node.js 24+, Rust/Cargo, and an installed `Ubuntu-24.04` WSL distribution. It downloads a pinned Zebra 6.4.2 Linux release, checks the archive hash, builds the native fixture and creates an isolated node with no peers. The first Rust build can take several minutes.

From this repository:

```powershell
npm test
pwsh -NoProfile -File ./scripts/run-regtest.ps1
```

Open the resulting `reports/<run>/report.html`. Its sibling `report.json` is the machine-readable result. The launcher stops its node after the run, including application-failure paths. Runtime diagnostics stay in ignored `.local/runs/<run>/`.

Use an existing official archive without downloading again:

```powershell
pwsh -NoProfile -File ./scripts/run-regtest.ps1 -ZebraArchive ./downloads/zebrad-6.4.2-x86_64-unknown-linux-gnu.tar.gz
```

`-NoBuild` reuses the current native release binary. Omit it after changing Rust code. `-Distribution` selects an installed WSL distribution. `-ReportDirectory` selects a new output directory; existing directories are refused. No wallet setup, faucet or real funds are required.

## Read the result

| Result | Meaning |
| --- | --- |
| Native settlement verified | Zebra accepted and confirmed the fully shielded checkout payment after a separate funding transaction. |
| Copied receipt granted access | The deliberately vulnerable fixture broke its declared order-access policy. |
| Copied receipt denied; owner granted once | The corrected fixture enforced the separate capability and one-time claim. |
| Canary finding | Registered payment data appeared in a forbidden captured sink. The value itself is removed from the report. |
| No observed canary findings | The stated completed capture contained none of the registered representations. Unobserved surfaces remain unknown. |
| Incomplete | Required native, application or capture evidence was missing. It cannot count as a pass. |

Exit `0` means the benchmark observed its expected failures and passing controls. Exit `1` means an expectation failed. Exit `2` means required evidence was incomplete. Usage errors exit `64`. Deliberate fixture failures are expected findings; they do not make the benchmark itself unsuccessful.

## How it works

```mermaid
flowchart LR
  A[Fresh test coins] --> B[Shield funding]
  B --> C[Fully shielded checkout payment]
  C --> D[Confirm on isolated Zebra]
  D --> E[Recover one selected output]
  E --> F[Compare checkout policies]
  F --> G[Redacted JSON and HTML]
```

Rust owns native transactions and selected-output recovery. Node drives real loopback checkout HTTP requests and captures the checkout child's stdout/stderr plus its designated telemetry endpoint. Known canaries are checked in raw, URI-encoded and Base64 forms.

A selected-output receipt reveals its recipient, amount and memo. It proves neither the payer's identity nor the presenter's right to claim an order. The corrected fixture keeps order authorization separate and out of the payment memo. A bearer-receipt product can choose a different policy; this benchmark explicitly requires the separate capability.

Read the [coverage and trust model](docs/benchmark.md) and [native interface](docs/native-contract.md). The current native fixture uses NU6.3's Ironwood pool. It trusts its local full node for chain state and uses one confirmation for disposable tests.

## Development

```powershell
npm test
npm run build:site
pwsh -NoProfile -File ./test/launcher.test.ps1
cargo test --locked --release --manifest-path native/Cargo.toml
cargo fmt --manifest-path native/Cargo.toml -- --check
cargo clippy --locked --manifest-path native/Cargo.toml --all-targets -- -D warnings
```

Contract tests that substitute a verifier prove application behavior only. The launcher run is required to establish native payment and receipt evidence. Direct CLI use is available for a separately owned fresh node:

```powershell
$nativeExe = (Resolve-Path ./native/target/release/shieldcheck-native.exe).Path
node ./src/cli.mjs --native $nativeExe --rpc-port 18232 --out ./reports/my-new-run
```

The node must match the exact isolated regtest context in the native contract. The CLI refuses to substitute simulated settlement when native verification is unavailable.

## Project status

ShieldCheck is new work for the 2026 ZECATHON Core & Tooling track. The local browser analyzer, offline capture CLI and native benchmark are available in this source tree. Public deployment and final event submission remain separate release steps until verified. External application integration and developer validation are unverified. No claim of an existing ecosystem vulnerability is made.

MIT licensed. Rust dependency versions and upstream licenses are recorded through `native/Cargo.lock` and the referenced upstream projects; Zebra remains separately licensed tooling.
