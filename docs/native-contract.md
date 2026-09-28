# Native benchmark boundary

This is a disposable regtest fixture, not a wallet or standardized payment-receipt format. Its selected-output disclosure proves payment content. It does not prove who may claim an order. Both fixture variants declare that order access requires the capability issued at order creation.

The native executable accepts one bounded JSON document on stdin and emits one JSON document on stdout. Secrets never appear in command-line arguments or error text. The only endpoint selector is an integer `rpcPort`; RPC is always `http://127.0.0.1:<port>`. Redirects are forbidden. Time and response sizes are bounded.

## Create payment

Command: `shieldcheck-native pay`.

Input: `{ "rpcPort": 12345, "memo": "fresh synthetic order memo", "amountZat": 100000 }`.

Requires a fresh height-zero regtest node with no peers, exact regtest genesis `029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327` and NU6.3 branch `37a5165b`. Generate disposable random keys, mine mature funding, shield it, then make a fully shielded Ironwood payment with the exact invoice amount and memo. Native transaction proofs and signatures must be accepted by Zebra. Inspect the final transaction to enforce absence of a transparent bundle.

Successful output:

```json
{
  "status": "created",
  "receipt": {
    "schema": "shieldcheck-receipt/v1",
    "network": "regtest",
    "pool": "ironwood",
    "txid": "64 lowercase hex characters",
    "actionIndex": 0,
    "ock": "64 lowercase hex characters"
  },
  "expected": {
    "recipient": "86 lowercase hex characters (raw 43-byte address)",
    "amountZat": 100000,
    "memo": "fresh synthetic order memo"
  },
  "evidence": {
    "network": "regtest",
    "pool": "ironwood",
    "genesis": "canonical genesis hash",
    "branchId": "37a5165b",
    "txid": "canonical transaction hash",
    "blockHash": "canonical block hash",
    "blockHeight": 103,
    "confirmations": 1,
    "shieldedOnly": true
  }
}
```

The entire result is private ephemeral data. Public reports use a strict allowlist of non-sensitive verification facts; never serialize this result wholesale.

## Verify payment

Command: `shieldcheck-native verify`.

Input: `{ "rpcPort": 12345, "receipt": { ... }, "expected": { ... } }`.

Fetch the transaction independently from the pinned local node. Confirm canonical block membership, at least one confirmation, exact transaction hash and consensus branch. Recover the selected Ironwood output using its per-output outgoing cipher key and the official note-encryption implementation. Require an exact recipient, integer amount and full padded memo match. Reject unexpected networks, pools, schemas, trailing data, malformed encodings and unconfirmed transactions. The expected invoice comes from checkout state, never from the claimant.

Outputs and exit codes:

- Exit 0: `{ "status": "verified", "evidence": { ... } }` with the same evidence shape above.
- Exit 2: `{ "status": "rejected", "code": "invalid_receipt" }` for invalid disclosures or payment mismatch, or `invalid_input` for malformed input.
- Exit 1: `{ "status": "error", "code": "native_unavailable" }` for unavailable/unexpected RPC or runtime failure. Infrastructure errors cannot count as security-test passes.

No raw RPC response, path, memo, key, capability, recipient or disclosure may appear in an error. CLI usage failures emit a fixed error and exit nonzero.

## Coverage

The Node benchmark drives actual loopback checkout HTTP requests, and captures only its own checkout child stdout/stderr and its designated telemetry sink. Raw, URI-encoded and Base64 representations of registered canaries are tested. Unobserved network destinations, browsers, unknown encodings and arbitrary third-party apps are outside this benchmark. Any missing capture, failed child, oversized capture or timeout makes the affected run incomplete.
