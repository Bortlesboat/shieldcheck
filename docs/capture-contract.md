# Supplied capture contract

ShieldCheck can inspect captures exported by a test harness. This analysis checks registered canaries in supplied text. It does not run the harness, observe network traffic, verify a receipt, or evaluate native settlement. Use synthetic canaries in disposable tests. A result without findings is not a privacy certification.

The existing native benchmark remains separate. Its `Capture` owner retains the process lifecycle and overflow rules; both interfaces use the dependency-free matcher in `src/disclosures.mjs`.

## Input

[`examples/capture-input.json`](../examples/capture-input.json) is a deliberately leaky synthetic example. The UTF-8 JSON document has exactly these keys:

```json
{
  "schema": "shieldcheck-capture/v1",
  "canaries": [{ "field": "memo", "value": "synthetic memo /+" }],
  "requiredSurfaces": ["stdout"],
  "captures": [{ "surface": "stdout", "text": "event completed", "complete": true }]
}
```

- Canary fields: `memo`, `receipt`, `ock`, `recipient`, `capability`. Register one to five nonempty, well-formed Unicode strings, with each field used at most once.
- Capture surfaces: `stdout`, `stderr`, `telemetry_url`, `telemetry_body`. Supply zero to four captures, with each surface used at most once. An empty `text` string is allowed. Each capture requires a Boolean `complete`; this is the caller's declaration only.
- `requiredSurfaces` contains one to four distinct allowed surfaces. A required surface without a capture makes the result incomplete. Any supplied capture with `complete: false` also makes it incomplete, including one outside `requiredSurfaces`.
- Objects accept only the documented keys. Unknown field or surface names, duplicate names in the arrays, malformed structure, and invalid string values return the same generic error. JSON uses standard `JSON.parse` behavior, including the last member winning when an object repeats a member name.

The exported `SCAN_LIMITS` object defines these fixed bounds:

| Property | Limit | Meaning |
| --- | ---: | --- |
| `inputBytes` | 1,048,576 | UTF-8 bytes of the entire JSON document |
| `canaryBytes` | 4,096 | UTF-8 bytes per canary value |
| `captureBytes` | 131,072 | Retained UTF-8 bytes per capture |
| `canaries` | 5 | Canary entries |
| `captures` | 4 | Capture entries |

The total input bound includes JSON syntax and escaping. A document beyond that bound is invalid and is not analyzed. An individual capture beyond its bound is analyzed only within its retained prefix and makes the report incomplete; findings in that prefix survive. A partial UTF-8 character at the boundary is omitted. Findings in discarded data are unavailable. Input limits apply before matching; the caller must bound input acquisition as well.

## API

`src/scan.mjs` exports:

```js
import {
  scanCaptureText, scanCaptures,
  CAPTURE_FIELDS, CAPTURE_SURFACES, SCAN_LIMITS,
} from './src/scan.mjs';

const report = scanCaptureText(jsonText);
// Or supply an already parsed document:
const sameReport = scanCaptures(document);
```

Both functions synchronously return a redacted report, including on invalid input. They do not perform I/O. `scanCaptures` accepts ordinary data objects and arrays, rejects accessors, sparse arrays and custom prototypes, and applies the total size limit to their reconstructed JSON serialization. `scanCaptureText` additionally bounds the original JSON text. The constants are frozen arrays/objects; findings and surface lists use their stable enum order.

For byte input, decode UTF-8 with `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` and reject decoding failures. A byte-order mark is not accepted as JSON whitespace. The CLI handles this decoding itself.

The lower-level `findDisclosures(capturedText, surface, canaries)` export in `src/disclosures.mjs` performs matching only. Its canaries use the native `{ name, value }` shape. It expects already bounded strings and does not validate or redact arbitrary labels. Browser and external-harness integrations should use `scan.mjs`.

## Report

A supplied-capture report is distinct from `shieldcheck-report/v1` native evidence:

```json
{
  "schema": "shieldcheck-scan-report/v1",
  "status": "no_findings",
  "provenance": "unverified",
  "nativeSettlement": "not_evaluated",
  "findings": [],
  "coverage": {
    "status": "declared_complete",
    "reasons": [],
    "requiredSurfaces": ["stdout"],
    "suppliedSurfaces": ["stdout"]
  }
}
```

`status` is `findings`, `no_findings`, `incomplete`, or `invalid`. Incompleteness takes precedence over findings, but the `findings` array remains populated. `no_findings` means only that no registered canary appeared in the supported representations within the supplied declared-complete scope. Neither provenance nor capture completeness is independently verified.

Each finding contains only allowlisted `surface`, `field`, and `encoding` values. Encoding is `raw`, `uri`, or `base64`. No captured text, canary value, filename, custom label, timestamp, receipt contents, or caller metadata appears in the report.

Coverage status is `declared_complete` or `incomplete`. Reasons appear in this order when applicable: `missing_required_surface`, `declared_incomplete`, `capture_overflow`. Invalid input has empty finding and surface arrays, coverage reason `invalid_input`, and the additional fixed field `"error": "invalid_capture_input"`. Structural failures and excessive total input do not return partial analysis.

## CLI

Requires Node.js 24 or later. Read a file or UTF-8 stdin:

```text
node src/scan-cli.mjs --input examples/capture-input.json
node my-capture-exporter.mjs | node src/scan-cli.mjs --stdin
```

Use `--help` for fixed usage text. The CLI accepts no canary values, URLs, commands, custom labels, or detector options as arguments. It emits the JSON report on stdout. Invalid input, arguments, UTF-8, excessive total input, and unreadable files all produce `invalid_capture_input` on stderr without filenames or operating-system diagnostics.

| Exit code | Result |
| --- | --- |
| `0` | `no_findings` in supplied declared-complete scope; also `--help` |
| `1` | `findings` in supplied declared-complete scope |
| `2` | `incomplete`, possibly with findings |
| `64` | `invalid`, including argument and read failures |

## Matching boundary

The matcher checks exact full strings, URI representations, and UTF-8 byte sequences within canonical single-layer standard Base64 tokens. Base64 tokens must have canonical padding and zero padding bits; decoded envelopes can contain a full canary at any byte alignment. Base64url, recursive decoding, hashes, fragments, and alternative encodings are outside this contract.

A Base64 token is a maximal run of `A-Z`, `a-z`, `0-9`, `+` and `/`, followed by its padding. Surrounding characters from that alphabet become part of the same token. Whitespace, quotes and query separators can delimit tokens; `/` cannot. URL path segments are not parsed separately, so a Base64 value in `/collect/<value>` may not be detected. Use the documented representations when constructing regression captures; a result without findings does not rule out disclosures in unsupported representations.

All surfaces check `encodeURIComponent` representations. Only `telemetry_url` also checks `URLSearchParams` and WHATWG URL query serialization. Values that URL parsing would truncate are not registered as partial canaries. Unicode normalization and case folding are not performed.

Supplied captures cannot establish what a process omitted, which destinations were monitored, or whether imported data is authentic. Keep those claims separate from canary findings and from the native benchmark's recorded settlement evidence.
