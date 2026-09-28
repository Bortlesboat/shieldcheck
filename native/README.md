# Native fixture

This fresh benchmark creates disposable funds on an isolated Zebra regtest node.
It mines mature transparent coinbase funding, shields the funding into Ironwood,
then makes a real shielded payment to a new merchant address. Both transactions
use the upstream transaction builder and real Halo 2 proofs and signatures.

Build with `cargo build --manifest-path native/Cargo.toml --release --locked`.
Run focused tests with `cargo test --manifest-path native/Cargo.toml --locked`.
The Node benchmark invokes the executable using the JSON interface in
[the native contract](../docs/native-contract.md). Do not put the JSON document in
command-line arguments or persist the result: it includes selected-output
disclosure material and private invoice contents.

The executable accepts at most 8 KiB on stdin, an invoice amount of 1–1,000,000
zatoshis, and a nonempty memo of at most 512 UTF-8 bytes. RPC responses are limited
to 8 MiB. Reading input has a five-second deadline; verification has a 30-second
process deadline; payment creation has a 20-minute process deadline. The only
endpoint selector is a nonzero integer loopback port. Proxies and redirects are
disabled.

Payment creation requires the exact regtest genesis, NU6.3 activated at height
one, height zero, no peers, and an empty mempool. The parent launcher owns node
configuration and lifecycle. The native fixture never starts or stops a node.
It positively checks that the payment is in the mempool, requires the verifier
to reject its unconfirmed receipt, mines it, then requires confirmed verification.

Verification independently fetches the transaction from this trusted local node,
checks the transaction version and branch, rejects transparent or other-pool
bundles, checks canonical block inclusion, and decrypts just the selected Ironwood
output with its outgoing cipher key. Recipient, integer amount, and all 512 padded
memo bytes must match the checkout's invoice. This is a benchmark receipt format,
not ZIP 311 or proof of payer identity or order authority. Node acceptance is the
source of proof/signature and chain validity; this executable is not a second
consensus node or a public-chain wallet.

Malformed inputs and invalid receipts exit 2 with fixed codes. Unexpected RPC,
transport, timeout, and runtime failures exit 1. Only the documented missing
transaction RPC code is treated as a missing receipt; an infrastructure error
cannot pass a security negative control. Panics are sanitized. Fixed progress
messages on stderr contain no payment material.

The disabled Sapling prover type satisfies the upstream builder's generic
interface and cannot produce a proof. Sapling and Orchard builders are disabled;
Ironwood proof generation always uses the real upstream prover. The output-opening
unit test exercises real encryption and recovery without generating a proof.
Only the integrated node run establishes real settlement.

Primary upstream components, pinned in `Cargo.toml` and `Cargo.lock`:

| Component | Version | Upstream |
| --- | --- | --- |
| `orchard` | 0.15.5 | [zcash/orchard](https://github.com/zcash/orchard) |
| `zcash_primitives` | 0.30.0 | [zcash/librustzcash](https://github.com/zcash/librustzcash) |
| `zcash_protocol` | 0.10.4 | [zcash/librustzcash](https://github.com/zcash/librustzcash) |
| `zcash_transparent` | 0.10.0 | [zcash/librustzcash](https://github.com/zcash/librustzcash) |
| `zcash_note_encryption` | 0.4.2 | [zcash/librustzcash](https://github.com/zcash/librustzcash) |
| `sapling-crypto` | 0.7.0 | [zcash/sapling-crypto](https://github.com/zcash/sapling-crypto) |

These upstream cryptographic crates are used under their published MIT or
Apache-2.0 terms. No private pre-event application source was copied.
