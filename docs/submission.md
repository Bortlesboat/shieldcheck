# ShieldCheck — ZECATHON 2026

Track: **Core & Tooling**

- [Source code](https://github.com/Bortlesboat/shieldcheck)
- [Working demo](https://bortlesboat.github.io/shieldcheck/)
- [Two-minute video](https://bortlesboat.github.io/shieldcheck/demo.html)

ShieldCheck is a regression lab for privacy at the Zcash checkout boundary.

A shielded payment can still leak through application logs or telemetry. A valid payment receipt can also be copied; it cannot establish who may claim an order.

Try the live browser analyzer: compare leaky, corrected and incomplete synthetic captures, or import a capture from your own test harness. It detects registered canaries in raw text, standard URI encodings and canonical Base64 envelopes. Missing observations stay incomplete, with detected leaks preserved. Input stays in your browser. Downloaded reports contain only allowlisted field, surface and encoding metadata. The offline CLI uses the same detector.

The native benchmark is real: Rust constructs a fully shielded Ironwood payment, Zebra confirms it on an isolated regtest chain, and native verification recovers the selected output. Both checkout fixtures verify the same payment. The deliberately vulnerable fixture grants a copied receipt access; the corrected fixture requires a separate order capability, allows one authorized fulfillment and rejects replay. All 24 benchmark expectations passed, including four planted disclosure findings and zero registered findings in the corrected capture. Dated evidence and reproduction commands are published with the source.

Synthetic: browser examples, disposable regtest funds and our own checkout fixtures. Supplied captures have unverified provenance; the browser does not verify settlement or certify privacy. No third-party vulnerability or independent developer adoption is claimed.

Built fresh for ZECATHON, MIT licensed, with a reusable capture contract and automated checks.
