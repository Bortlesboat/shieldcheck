# ShieldCheck demonstration

The [two-minute video](https://bortlesboat.github.io/shieldcheck/demo.html) uses captured product screens with narration and English captions. Browser examples are synthetic; native evidence is the immutable September 28, 2026 regtest run.

## 0:00–0:16

A shielded payment can still end in a leaky checkout. ShieldCheck tests the application boundary around Zcash: what a checkout exposes, and whether a valid payment receipt gives the wrong person access.

## 0:16–0:37

Start with this synthetic capture. The analyzer finds registered test values in standard output and telemetry, including URI encoding and a Base64 envelope. The report tells us which field appeared, where, and in which encoding. It leaves the values out.

## 0:37–0:49

The corrected capture has no registered findings. This is a statement about the supplied capture, not a privacy certificate. The browser does not verify a payment or observe traffic you did not supply.

## 0:49–1:03

Remove an observation and the result becomes incomplete. A leak already found stays visible. Missing evidence cannot turn into a clean bill of health. Analysis happens locally in this browser; your input is not uploaded.

## 1:03–1:23

Now the native evidence. This recorded benchmark built a real fully shielded payment on an isolated Zcash regtest node. Zebra confirmed it at block one hundred and three. Twenty-four benchmark expectations passed. These are disposable test funds, and this is recorded evidence.

## 1:23–1:43

Both checkouts verify the same payment. Copying the valid receipt wins the order in the deliberately vulnerable checkout. The corrected checkout denies that copy. It requires a separate order capability, gives the authorized holder access once, and rejects a replay. Payment validity and order authority are different checks.

## 1:43–2:00

Use the same detector from the offline command line, supply captures from your test harness, or reproduce the native benchmark from source. ShieldCheck makes checkout regressions visible and produces a report you can share without sharing the secret values.
