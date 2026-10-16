# 04 — Operations: keep-cold

`keep-cold.mjs` probes every relay with a real streaming inference request
per model in `PROBE_MODELS` (chat + responses wire paths, official-client
fingerprint headers) and restarts only throttled relays' `warp-N`
containers until every model answers 200. Tunnels and the relay app are
never touched, so every `<RELAY-N-URL>` survives rotation.

## Probe / rotate logic

- Per-model-per-egress: throttling is per model per `<EGRESS-IP>`, so one
  model probe misses throttles — hence the multi-model default.
- `GLOBAL_QUOTA_GUARD` (default `max(8, COUNT - 1)`, i.e. 9 at COUNT=10,
  capped at `COUNT`): a model 429 on that many relays is upstream quota,
  not egress — skipped for rotation this pass. The high default matters
  because recycled egress addresses can come up throttled in batches; a
  low guard would mistake a bad batch for upstream quota and rotate nothing.
- Speed ranking is logged (`speed <model>: #N Nms …`) but rotation on speed
  is disabled (`SLOW_THRESHOLD_MS=0`): single-sample rank proved to be
  upstream noise. Re-enable only on median-over-N evidence.
- **Two-Tier Rotation:**
  - **Tier 1 (Default):** Restarts only the container (`docker restart warp-relay-warp-N`). Keeps the existing WireGuard keys in `/etc/wireguard` but acquires a fresh `/64` egress IP path from Cloudflare without spending an account registration.
  - **Tier 2 (Fallback):** If a relay remains throttled after Tier 1, clears `/etc/wireguard/wg0.conf` and restarts to force a brand new account registration.
- **Upstream `server_error` Detection:** Scans the first 2 SSE chunks on HTTP 200 responses to catch upstream provider crashes ("The model failed to generate a response"), preventing futile rotation loops during upstream outages.
- Concurrency: `runPool` bounds parallel restarts by `ROTATE_CONCURRENCY`.
```bash
node keep-cold.mjs --once            # single pass (what the timer runs)
INTERVAL_S=600 node keep-cold.mjs --loop   # pass every 10 min, foreground
```

## Tunables

| Env | Default | Meaning |
| --- | --- | --- |
| `RELAY_HOST` | `10.244.0.100` | Relay app bridge address probed directly (not via tunnels) |
| `BASE_PORT` | `3000` | Relay N probed at `BASE_PORT+N` |
| `COUNT` | `10` | Relays probed |
| `PROBE_TARGET` | `https://api.kilo.ai` | Upstream the probes go through (Zen's free tier refuses non-OpenCode clients since 2026-10-14) |
| `PROBE_CHAT_PATH` / `PROBE_RESPONSES_PATH` | `/api/gateway/chat/completions` / `/api/gateway/responses` | Wire paths under `PROBE_TARGET` |
| `PROBE_MODELS` | `nvidia/nemotron-3.5-lightning:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free` | One probe each per relay (`PROBE_MODEL` = legacy single override) |
| `RESPONSES_MODELS` | `dots-studio/dots-3-note-preview:free` | Probed via `PROBE_RESPONSES_PATH`; rest via `PROBE_CHAT_PATH` |
| `GLOBAL_QUOTA_GUARD` | `max(8, COUNT - 1)` (= 9 at `COUNT=10`) | 429-on-this-many-relays = upstream quota, skip rotation (capped at `COUNT`; override via env, see `.env.example`) |
| `SPEED_MODEL` / `SLOW_THRESHOLD_MS` / `SLOW_MAX_ROTATIONS` | `nvidia/nemotron-3.5-lightning:free` / `0` / `2` | Speed rotation, disabled by default |
| `MAX_ROTATIONS` | `4` | Restarts per 429-relay per pass |
| `ROTATE_CONCURRENCY` | `3` | Parallel restarts |
| `CONTAINER_PREFIX` | `warp-relay-warp-` | `docker restart ${PREFIX}N` target |
| `READY_TIMEOUT_MS` / `PROBE_TIMEOUT_MS` | `180000` / `30000` | Post-restart WARP ready wait / per-probe timeout |
| `INTERVAL_S` | `300` | `--loop` seconds between passes |
| `KEEP_COLD_LOG` (+ `_MAX_BYTES` / `_KEEP_BYTES`) | stdout only / `2 MiB` / `200 KiB` | Optional file log with self-rotation |

## Warp-only rule

`docker restart warp-relay-warp-N` (or `docker restart warp-N` inside
compose) is the only rotation action. Never restart `tunnel-N` or `relay`
for a hot egress: tunnel restarts mint new `*.trycloudflare.com` URLs
(breaking every pasted `/freeflow add` line) and relay restarts drop all
ten listeners for nothing.

## Logs

Stdout always (journald: `journalctl -u warp-keep-cold.service`);
`KEEP_COLD_LOG=/path/keep-cold.log` additionally appends to a self-
rotating file. Each pass logs per-relay `200`/`429` per model, rotations
with before/after `<EGRESS-IP>`, quota-guard skips, and the speed line.
