# 04 — Operations: keep-cold

`keep-cold.mjs` runs one pass per timer fire and probes a relay with a real
streaming inference request per model in `PROBE_MODELS` (chat + responses
wire paths, official-client fingerprint headers). Probing is demand-driven:
after a one-time baseline sweep a pass touches only a handful of relays (see
[Cost control](#cost-control)), and only a relay that actually answered with a
throttle is restarted — at most once per `RELAY_COOLDOWN_S`. Tunnels and the
relay app are never touched, so every `<RELAY-N-URL>` survives rotation.

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
- Concurrency: `ROTATE_CONCURRENCY` (default `1`) bounds restarts, and they
  are additionally serialised at least `ROTATE_SPACING_MS` apart regardless of
  that value (concurrent WARP restarts can trip Cloudflare registration limits
  and a slow host disk cannot take two container stop/starts at once).
  Probing is bounded separately by `PROBE_CONCURRENCY`.
- Tier-2 budget: at most **one re-key per relay per pass**, and no re-key for
  the same relay within `TIER2_MIN_INTERVAL_S` (default 1 h), persisted in
  `TIER2_STATE_FILE` (default `.keep-cold/tier2-state.json`).

```bash
node keep-cold.mjs --once            # single pass (what the timer runs)
INTERVAL_S=600 node keep-cold.mjs --loop   # pass every 10 min, foreground
node keep-cold.mjs --help            # usage (unknown flags exit 2)
```

## Cost control

An inference probe is itself traffic that can trip the throttle it is looking
for, and every `docker restart` is a container stop/start plus a WARP
re-handshake. Both are therefore budgeted rather than run on every relay every
pass.

**Baseline vs demand-driven.** The first pass on a host with no
`RELAY_STATE_FILE` sweeps the whole pool and writes per-relay state. Every
later pass probes only:

| Candidate | Why it is probed |
| --- | --- |
| relay flagged `pendingVerify` and past `EGRESS_SETTLE_S` | it was just restarted; nothing is known about the new egress yet |
| relay still dirty whose `cooldownUntil` has expired | the throttle was never confirmed fixed |
| round-robin audit sample of `PROBE_AUDIT_SAMPLE` clean relays | catches a silent throttle before live traffic reports it |

On a healthy pool that is the audit sample (default 2 relays) per pass instead
of `COUNT` relays × `len(PROBE_MODELS)`.

**Rotation budget.** One restart per relay per pass, gated by
`RELAY_COOLDOWN_S` (600 s) and a hard `RELAY_MAX_ROTATIONS_PER_HOUR` (2) per
rolling hour. Consecutive failures escalate the cooldown exponentially —
`max(RELAY_BACKOFF_BASE_S · 2^(n-1), RELAY_BACKOFF_MAX_S)`, i.e. 300 s → 600 s
→ 1200 s → capped at 3600 s — so a genuinely bad egress cannot spend the hourly
budget in a few passes.

**Settle window.** A restarted relay is treated as throttled-free for
`EGRESS_SETTLE_S` (150 s) and is not probed inside that window. Probing during
the WARP handshake is what used to produce false 429s and back-to-back restarts.

**Honouring `Retry-After`.** A 429 that carries `retry-after: N` with
`N <= 120` schedules the next attempt at that deadline instead of restarting the
container: upstream has already said when it will accept traffic again.

**Restart spacing.** Restarts are serialised at least `ROTATE_SPACING_MS`
(4000 ms) apart, so the host disk never sees two container stop/starts at once.

**Live signals.** With a relay image built with the signal writer and
`LIVE_SIGNALS=1`, the relay app appends one record per `(relay, model)` state
change to `LIVE_SIGNAL_FILE` and keep-cold processes it with no probe at all: a
`status: 429` record routes that relay straight through the rotation gate (and
feeds the quota-guard history), any other status marks that relay clean. The
file is consumed destructively — after a pass it is atomically rewritten as
`{"signals":[]}` — so the relay app owns appends and keep-cold owns resets, and
one writer each keeps the host disk quiet. With `LIVE_SIGNALS=0` keep-cold never
touches the file, and the flag is read separately by each process — the
generator bakes it into the relay container while the host run takes it from its
own `Environment=`/`--env-file`, so enabling one side alone changes nothing.

This path is optional: when the file is absent or corrupt the probe scheduler
above runs unchanged, so a pool that never enables signals still converges. The
relay app sees the file at `/signals/signals.json` only because the compose file
bind-mounts `./.keep-cold:/signals`; the host prober reads the same bytes as
`.keep-cold/signals.json`. `retry-after` inside a signal record is informational
only — only a probe's own 429 can schedule a retry instead of a restart.

**Degradation.** State lives in `RELAY_STATE_FILE` (`.keep-cold/state.json`,
gitignored) and is written merge-on-write so concurrent writers cannot lose
fields. A corrupt or unwritable state file never fails a pass — it falls back
to a baseline sweep, and the exit status is unaffected.

## Exit status

- `0` — every relay answered 200 for every probed model.
- `1` — pool is not cold: a relay is throttled, quota-capped,
  `server_error`, unreachable, or returned a bad gateway, or a relay was just
  rotated and is still awaiting verification (pending the settle window). Quota-capped
  relays are deliberately **not** counted clean: when the upstream free
  tier throttles a model on `GLOBAL_QUOTA_GUARD` relays, rotation cannot
  help and the pass skips it, but the unit still reports failure so a
  fully throttled pool never looks green.
- `2` — usage or configuration error.

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
| `SPEED_MODEL` / `SLOW_THRESHOLD_MS` / `SLOW_MAX_ROTATIONS` | `nvidia/nemotron-3.5-lightning:free` / `0` / `2` | Speed rotation, disabled by default (`SLOW_MAX_ROTATIONS` is legacy: no per-pass rotation loop remains) |
| `RELAY_STATE_FILE` | `.keep-cold/state.json` | Per-relay scheduler state (gitignored; corrupt state degrades to a baseline sweep) |
| `RELAY_COOLDOWN_S` | `600` | Minimum gap between two rotations of the same relay |
| `RELAY_BACKOFF_BASE_S` / `RELAY_BACKOFF_MAX_S` | `300` / `3600` | Exponential cooldown on consecutive failures: `max(300 · 2^(n-1), 3600)` |
| `RELAY_MAX_ROTATIONS_PER_HOUR` | `2` | Hard cap on restarts of one relay in a rolling hour |
| `PROBE_AUDIT_SAMPLE` | `2` | Clean relays probed per pass (round-robin) to catch silent throttles |
| `EGRESS_SETTLE_S` | `150` | Quiet window after a restart before the relay is probed again |
| `ROTATE_SPACING_MS` | `4000` | Minimum gap between `docker restart` calls |
| `PROBE_CONCURRENCY` | `4` | Parallel probes per pass (probes only, never restarts) |
| `LIVE_SIGNALS` / `LIVE_SIGNAL_FILE` | `0` / `.keep-cold/signals.json` (container: `/signals/signals.json`) | Live-429 input written by the relay app; needs a rebuilt relay image plus the compose `.keep-cold` mount. Absent file = probe scheduler unchanged |
| `TIER2_MIN_INTERVAL_S` / `TIER2_STATE_FILE` | `3600` / `.keep-cold/tier2-state.json` | Minimum gap between tier-2 re-keys for one relay, persisted across timer fires |
| `ROTATE_CONCURRENCY` | `1` | Parallel rotations (serial by default) |
| `MAX_ROTATIONS` | `4` | **Legacy** — accepted, no longer used: a pass makes at most one restart per relay (see `RELAY_COOLDOWN_S` / `RELAY_MAX_ROTATIONS_PER_HOUR`) |
| `SOCKS_HOST` / `SOCKS_PORT_BASE` | `127.0.0.1` / `10800` | **Legacy** — accepted; a restarted relay is skipped until `EGRESS_SETTLE_S` instead of being waited on inline |
| `SERVER_ERROR_RETRY` / `SERVER_ERROR_REPROBE_MS` | `1` / `5000` | Same-egress re-probes before a server_error t1 |
| `SERVER_ERROR_GUARD` | `9` (capped at `COUNT`) | server_error on this many relays = upstream incident, skip rotation |
| `CONTAINER_PREFIX` | `warp-relay-warp-` | `docker restart ${PREFIX}N` target |
| `READY_TIMEOUT_MS` / `PROBE_TIMEOUT_MS` | `180000` / `30000` | `READY_TIMEOUT_MS` is **legacy** (no inline post-restart wait); `PROBE_TIMEOUT_MS` is the per-probe timeout |
| `INTERVAL_S` | `300` | `--loop` seconds between passes |
| `KEEP_COLD_LOG` (+ `_MAX_BYTES` / `_KEEP_BYTES`) | stdout only / `2 MiB` / `200 KiB` | Optional file log with self-rotation |

## Warp-only rule

`docker restart warp-relay-warp-N` (or `docker compose restart warp-N`) is
the only rotation action. Never restart `tunnel-N` or `relay`
for a hot egress: tunnel restarts mint new `*.trycloudflare.com` URLs
(breaking every pasted `/freeflow add` line) and relay restarts drop all
ten listeners for nothing.

## Logs

Stdout always (journald: `journalctl -u warp-keep-cold.service`);
`KEEP_COLD_LOG=/path/keep-cold.log` additionally appends to a self-
rotating file.

An idle pass on a clean pool is a few lines — the audit sample it probed, the
verdict, and nothing else (budget: 10 lines idle, 50 on a noisy pass). Clean
relays never log a per-probe line. A busy pass adds the rotation it made, the
cooldown it is holding, the quota-guard skip, and the speed ranking line.

Logs never print egress IPs: rotation is reported as a relay index, not as an
address, so a journal export or a pasted log never leaks where the pool egresses
from. `./get-status.sh` stays the only place addresses are shown, and it prints
them for the operator at the console only.
