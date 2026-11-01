# 03 — Use with pi-freeflow (OMP/Pi client)

This pool is the self-hosted Docker/WARP alternative to the relays
`/freeflow deploy` creates — same protocol, same allowlist. Failover
behavior is the client's: see the [relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md).

End to end (fresh machine to fanned-out subagents):

```bash
git clone https://github.com/trefeon/warp-relay-pool.git
cd warp-relay-pool
./setup.sh            # default: 5 relays + TryCloudflare Quick Tunnels
```

Paste the printed `/freeflow add` lines into your OMP or Pi agent chat,
then verify and pick a mode (commands + mode table in
[Verify and pick a mode](#verify-and-pick-a-mode) below).

> Mesh-VPN `http://` relay URLs work on current pi-freeflow builds: mesh
> peer hosts — Tailscale `100.64.0.0/10` addresses, `*.ts.net` MagicDNS
> names, mesh ULA — accept plain `http://` with custom ports (the mesh
> layer already authenticates and encrypts). Older https-only builds
> silently skip them: upgrade the client, or use the Quick-Tunnel path
> below.

## Option A: TryCloudflare Quick Tunnels (Recommended for Easiest Setup)

When deployed with `--with-tunnels` (the default in `./setup.sh`), `./get-status.sh` prints ready-to-paste public HTTPS commands:

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
/freeflow add https://<hash-3>.trycloudflare.com relay-3
/freeflow add https://<hash-4>.trycloudflare.com relay-4
/freeflow add https://<hash-5>.trycloudflare.com relay-5
```

Paste these lines directly into your OMP or Pi agent chat. Zero VPN client configuration is required on your laptop or client machine. Then continue at [Verify and pick a mode](#verify-and-pick-a-mode).

> Note on tunnel URLs: each tunnel URL survives relay code rebuilds and
> per-egress 429 WARP rotations (tunnels carry no `depends_on: relay`,
> and rotation restarts `warp-N` only — never `tunnel-N`). But Quick
> Tunnels are ephemeral: restarting a `tunnel-N` container or rebooting
> the VPS mints new URLs. When that happens, re-run `./get-status.sh`
> and re-paste the `/freeflow add <RELAY-N-URL> relay-N` lines. Never
> restart `tunnel-N` for a throttled relay — that trades a per-egress 429
> for pool-wide URL churn.

## Option B: Mesh-VPN Direct (Tailscale)

If you deployed in mesh mode on a tailnet (`INGRESS_BIND=<tailscale-ip>
./generate-compose.sh N`), `./get-status.sh` prints Mesh-VPN commands:

```text
/freeflow add http://<tailscale-ip>:3101 relay-1
/freeflow add http://<tailscale-ip>:3102 relay-2
...
```

These URLs are static and permanent across reboots. Then continue at
[Verify and pick a mode](#verify-and-pick-a-mode).

## Verify and pick a mode

Verify, then pick a mode (`spread` for parallel subagents):

```text
/freeflow status
/freeflow list
/freeflow test
/freeflow spread
```

| Command | Meaning |
| --- | --- |
| `/freeflow auto` | Default. Relay turns on for `freeflow/*` models; sticky primary, rolls to the next healthy relay on 429/timeout/edge failure. |
| `/freeflow sticky` | Explicit alias for `auto`. |
| `/freeflow on` | Always relay (sticky primary), whatever model is selected. |
| `/freeflow spread` | Rotate each request across healthy relays — parallel sessions and subagents land on different egress IPs. |
| `/freeflow off` | Always direct to upstream, no relays. |

One entry per relay (relay-1 … relay-N); the client fans out across them,
each keeping its own WARP egress.

## Health checks

`./get-status.sh` prints one table row per relay (`INSTANCE`, `PORT`,
`EGRESS IP`, `TUNNEL URL`) plus the paste-ready `/freeflow add` lines and
the verify/mode next steps above. In tunnels mode the router publishes no
host port, so `PORT` shows the in-network `:300N` marked `*`; in mesh mode
it shows the dialable `:310N`. A `note: relays share egress IP(s)` line is
expected on IPv4 (Cloudflare WARP CGNAT) — per-relay isolation is per-IPv6
address.

No `x-relay-target` header = health check: the relay answers through its
own WARP client. Per-relay, via the bridge (from the Docker host):

```bash
curl -s http://10.244.0.100:3001/          # Relay #1 OK + cdn-cgi/trace body
```

Via the mesh address (same path the client uses):

```bash
curl -s http://<tailscale-ip>:3101/
```

Via the public URL, tunnels mode only (full path — edge, tunnel, relay,
WARP egress):

```bash
curl -s <RELAY-1-URL>/
```

`Relay #N health check failed` (HTTP `500`) = that relay's `warp-N`
SOCKS path is down; check `tunnel-N` logs only if every relay fails the
same way (shared relay app or host network, not one egress). A healthy
relay answers `200` with its Cloudflare trace body.

## Forwarded request shape

OpenCode Zen (models listing):

```bash
curl -s -N <RELAY-1-URL>/anything \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /inference/v1/models"
```

Kilo gateway (chat completions):

```bash
curl -s -N <RELAY-1-URL>/anything \
  -H "x-relay-target: https://api.kilo.ai" \
  -H "x-relay-path: /api/gateway/chat/completions"
```

OVHcloud AI Endpoints (keyless chat completions):

```bash
curl -s -N <RELAY-1-URL>/anything \
  -H "x-relay-target: https://oai.endpoints.kepler.ai.cloud.ovh.net" \
  -H "x-relay-path: /v1/chat/completions"
```

`x-relay-target` must be exactly one of the allowlist
(`RELAY_ALLOWED_TARGETS`, default `https://opencode.ai`,
`https://api.kilo.ai`,
`https://oai.endpoints.kepler.ai.cloud.ovh.net`); anything else is `403`.
Cline (`https://api.cline.bot`) is deliberately NOT on the allowlist: it
is a direct-only lane (per-user bearer token, no Zen-style per-IP gate to
route around), so relaying it 403s by design — keep it direct.
A path that would leave the target host (e.g. `.attacker.tld/...`) is
`400`. Upstream `3xx` redirects are refused (`502`), so an allowlisted
origin cannot steer the relay elsewhere.
`x-relay-path` defaults to `/`. To allow another upstream: set
`RELAY_ALLOWED_TARGETS` in `.env` (the generator sources it) or export it,
then re-run `./generate-compose.sh <count> [--with-tunnels]` and
`docker compose up -d` — the value is baked into the relay service
environment at generation time (see [02](02-deploy.md)). Exact-origin
entries never need a token; wildcard/regex entries require
`x-relay-auth: <token>` (`401` without it, stripped before upstream) — see
[06](06-universal-proxy.md).
