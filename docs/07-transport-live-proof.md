# 07 — Transport + fingerprint live proof

This runbook is for issue #20 acceptance work on a **live Linux pool** before
landing Bun transport changes.

## 1) TLS/HTTP fingerprint capture (Node vs Bun)

Use the same `warp-N` lane and egress `/64`, back-to-back:

1. Capture packets on the host (`tcpdump`/Wireshark) while sending one request
   from Node relay transport (`server.mjs`, undici `connections:32`,
   `keepAliveTimeout:60s`, `keepAliveMaxTimeout:90s`).
2. Repeat through the Bun fetch + loopback proxy path.
3. Compare ClientHello, ALPN, and HTTP header order from both captures.

## 2) 24h soak with keep-alive parity

- Keep probe concurrency `<= 4`
- Keep restarts serialized (`ROTATE_CONCURRENCY=1`)
- Keep `EGRESS_SETTLE_S=150`

Per-pass relay transport counters are available at:

```text
GET http://127.0.0.1:300N/__relay_metrics
```

The JSON includes:
- `rss` (process RSS bytes)
- `sockets.open`, `sockets.opened`, `sockets.closed`
- `sockets.tlsNew`, `sockets.tlsResumed`

Fail the soak if restart-to-restart RSS steps upward or socket-open count grows
monotonically.

## 3) Chat-path fingerprint matrix publication

Publish every exchange (`N/N`, no sampling):

```bash
PROBE_MATRIX_MODEL=deepseek-v4.1-flash-free \
PROBE_MATRIX_OUT=.keep-cold/fingerprint-matrix.ndjson \
PROBE_CONCURRENCY=4 \
node keep-cold.mjs --probe-matrix
```

Rows include `t_utc`, relay index, `/64`, status, raw retry-after, detail
(`<=160`), and envelope head on `200`, plus retry-after vs midnight-UTC
countdown reconciliation fields.

## 4) Bun reproducibility + CI parity

- Pin Bun image tags by digest in experiment artifacts.
- In CI, keep `actions/setup-bun` present so transport PRs run with the same
  Bun toolchain family used in live proof runs.
