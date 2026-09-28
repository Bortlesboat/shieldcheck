# What the benchmark proves

ShieldCheck tests application behavior around a native shielded payment. A blockchain can accept a correct payment while an application reveals its contents or gives the wrong person access to an order.

The benchmark creates its own checkout, node, accounts and synthetic data. The deliberately vulnerable fixture is a teaching example, not a reported vulnerability in an existing Zcash application.

## Three separate checks

1. **Settlement:** Zebra accepts the native transaction's proof and signatures and includes it in the active regtest chain. The checkout payment has no transparent inputs or outputs. A separate funding transaction first shields mined test coins.
2. **Payment content:** A verifier fetches the transaction again and recovers one output using its outgoing cipher key. It compares the recipient, exact amount and memo against the order stored by the checkout.
3. **Order access:** The checkout requires a separate order capability. Someone who copies only the payment receipt must not obtain the order. A valid receipt proves payment content; it does not identify the payer or authorize its holder to claim anything.

The test presents the copied receipt before the legitimate claim. This detects a checkout that gives access to the first person with the receipt, even if it later blocks reuse. The corrected fixture must leave the order available after denying an invalid claimant and grant it only once to an authorized claimant.

Some products deliberately use transferable bearer receipts. That is a different policy. This benchmark explicitly chooses nontransferable order access; it does not classify all transferable receipts as defects.

## Disclosure policy

| Data | Allowed destination | Forbidden destination |
| --- | --- | --- |
| Selected payment receipt | Checkout's native payment verifier | Analytics and ordinary process logs |
| Payment memo | Checkout and its verifier | Analytics URLs/bodies and ordinary process logs |
| Order capability | Checkout claim endpoint | Payment memo, receipt, analytics and report |
| Redacted verification facts | Local JSON and HTML report | No broader claim of universal privacy |

Only the benchmark's loopback HTTP sink and its own checkout child's stdout/stderr are observed. Matching covers registered memo, receipt and order-capability canaries in raw, URI-encoded and Base64 forms. URL matching includes query values serialized by WHATWG URL and URLSearchParams. Canonical standard Base64 tokens are decoded once within the capture limit, so a registered value inside a JSON envelope is still detected. It does not inspect arbitrary network destinations, browsers, external analytics providers, hashes, recursive encodings, Base64URL, wrapped tokens, custom encodings, encrypted exports or third-party applications.

Missing observations, a child crash, capture overflow, timeout or native infrastructure error make the affected result incomplete. A leak already observed remains a finding even when later capture fails. A zero-finding complete capture means only that no registered canary appeared on the stated surfaces during that run.

## Trust and limits

The verifier trusts the isolated local Zebra node for chain state; it is not a second consensus node or a public-chain light client. One confirmation suffices for this disposable benchmark. That choice is not production settlement advice. Reorganizations and production payment-finality policy need an application-specific integration.

The native fixture uses NU6.3's Ironwood pool and pinned current libraries. The [native contract](native-contract.md) documents its experimental disclosure format. It is neither ZIP 311 spend-authority proof nor a wallet interoperability standard.

The checkout keeps orders in memory. It does not implement persistent accounts, secure production sessions, wallet custody, shipping, refunds or commerce recovery. Sharing the separate capability alongside the receipt transfers its authority; the check does not prove a human identity.

Claim challenges expire after 30 seconds. Slow but successful verification calls can exhaust the benchmark's challenge window and fail its authorized-access control. Expired claims remain denied; a passing run is not a performance guarantee on another machine.

## Reproduction evidence

Generated reports contain only allowlisted verification facts and findings. Runtime logs and node state stay under the ignored `.local/` directory. Reports are written to a new directory under ignored `reports/` by default. Keep raw runtime artifacts private; publish only reviewed redacted examples.

The launcher and process cleanup are verified on Windows/WSL with non-detached children. Other-platform process containment is unverified. WSL helper calls have finite deadlines; a stopped Windows client does not establish that its Linux command stopped, so that uncertainty remains an incomplete cleanup result.

A successful benchmark exit means its expected vulnerable findings, corrected controls and failure handling were observed. It does not mean that the deliberately vulnerable checkout passed its policy. The report must make that distinction visible.

## Provenance

ShieldCheck application code was created during the 2026 ZECATHON build window. Existing private marketplace and collectible-wallet applications are not bundled. The implementation uses the official open-source [Zebra node](https://github.com/ZcashFoundation/zebra/releases/tag/v6.4.2), [librustzcash](https://github.com/zcash/librustzcash), [Orchard library](https://github.com/zcash/orchard) and Node.js standard library. Exact Rust dependencies are recorded in `native/Cargo.lock`.
