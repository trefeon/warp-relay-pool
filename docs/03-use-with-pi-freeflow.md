# 03 — Use with pi-freeflow (OMP/Pi client)

This pool is the self-hosted Docker/WARP alternative to the relays
`/freeflow deploy` creates — same protocol, same allowlist. Failover
behavior is the client's: see the [relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md).

> Mesh-VPN `http://` relay URLs need a pi-freeflow build with mesh-VPN
> peer relay support (older https-only builds skip them). Without that,
> use the Quick-Tunnel path below.

## Option A: TryCloudflare Quick Tunnels (Recommended for Easiest Setup)

When deployed with `--with-tunnels` (the default in `./setup.sh`), `./get-status.sh` prints ready-to-paste public HTTPS commands:

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
/freeflow add https://<hash-3>.trycloudflare.com relay-3
/freeflow add https://<hash-4>.trycloudflare.com relay-4
/freeflow add https://<hash-5>.trycloudflare.com relay-5
```

Paste these lines directly into your OMP or Pi agent chat. Zero VPN client configuration is required on your laptop or client machine.

> Note on tunnel URLs: TryCloudflare URLs are stable and survive container restarts, relay code updates, and 429 WARP rotations. Only a manual tunnel container recreation or VPS reboot mints new URLs. If that happens, simply run `./get-status.sh` and re-paste.

## Option B: Mesh-VPN Direct (Tailscale)

If you deployed in pure mode on a tailnet, `./get-status.sh` prints Mesh-VPN commands:

```text
/freeflow add http://<tailscale-ip>:3101 relay-1
/freeflow add http://<tailscale-ip>:3102 relay-2
...
```

These URLs are static and permanent across reboots.
Verify, then pick a mode (`spread` for parallel subagents):

```
/freeflow status
/freeflow list
/freeflow test
/freeflow spread
```

Modes: `/freeflow auto` | `/freeflow spread` | `/freeflow off`.
One entry per relay (relay-1 … relay-N); the client fans out across them,
each keeping its own WARP egress.

## Health checks

No `x-relay-target` header = relay answers directly through its own WARP
client. Per-relay, via the bridge (from the Docker host):

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

`500 … proxy error` = that relay's `warp-N` SOCKS path is down; check
`tunnel-N` logs only if every relay fails the same way (shared relay app
or host network, not one egress).

## Forwarded request shape

```bash
curl -s -N <RELAY-1-URL>/anything \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /zen/v1/models"
```

`x-relay-target` must be exactly one of the allowlist (`RELAY_ALLOWED_TARGETS`,
default `https://opencode.ai`, `https://api.kilo.ai`); anything else is `403`.
A path that would leave the target host (e.g. `.attacker.tld/...`) is `400`.
`x-relay-path` defaults to `/`. To allow another upstream: set
`RELAY_ALLOWED_TARGETS` in `.env` (the generator sources it) or export it,
then re-run `./generate-compose.sh <count> [--with-tunnels]` and
`docker compose up -d` — the value is baked into the relay service
environment at generation time (see [02](02-deploy.md)).
