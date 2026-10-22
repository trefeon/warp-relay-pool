# 01 — Overview: how it works

Self-hosted Docker/WARP alternative to the Workers/Deno/Vercel relays
[pi-freeflow](https://github.com/trefeon/pi-freeflow)'s `/freeflow deploy`
creates — the OMP/Pi extension (npm `pi-freeflow`): same
`x-relay-target`/`x-relay-path` protocol, same allowlist
(`https://opencode.ai`, `https://api.kilo.ai`). Client-side failover lives
there — see its [relays.md failover table](https://github.com/trefeon/pi-freeflow/blob/main/docs/pages/relays.md);
this repo documents the relay side only, not its model catalog.
One `relay` process exposes N listeners (`BASE_PORT+N`, default `3001`–`3000+N`).
Each listener forwards through its own MicroWARP client's SOCKS proxy
(`warp-N:1080`, ~1.8 MiB RAM each) and is reachable two ways:

1. **TryCloudflare Quick Tunnels (`--with-tunnels`):** Each relay is exposed as a public HTTPS URL (`https://<hash>.trycloudflare.com`). Zero configuration required—no Cloudflare account, domain, or client-side VPN needed.
2. **Mesh-VPN Direct (Tailscale):** Static private URLs (`http://<tailscale-ip>:310N`) published directly over an encrypted WireGuard mesh network.

```
[OMP/Pi via pi-freeflow] ──► https://<hash>.trycloudflare.com (TryCloudflare, public HTTPS)
                          └─► http://<tailscale-ip>:310N      (Mesh-VPN, static private)
      ──► [relay :300N] ──► [MicroWARP SOCKS :1080] ──► [upstream API, egress <EGRESS-IP>]
```

## Request lifecycle

1. Client sends the request to the relay URL with two headers
   (`server.mjs`: `x-relay-target`, `x-relay-path`).
2. Relay strips those headers (plus `host`), forwards
   `method + headers + body` to `target + relayPath` via that relay's
   own `ProxyAgent` dispatcher (`undici`), 5-minute cap
   (`AbortSignal.timeout(300000)`), client-disconnect abort wiring.
3. Relay answers with `cache-control: no-cache`,
   `x-accel-buffering: no`, upstream `content-type` only, `flushHeaders()`
   before the first body byte, then `pipeline(Readable.fromWeb(body), res)`
   — SSE tokens stream, nothing buffers. See `server.mjs`.
4. No `x-relay-target` header = health check: relay fetches
   `https://cloudflare.com/cdn-cgi/trace` through its own dispatcher and
   returns `Relay #N OK (via socks5://warp-N:1080)` plus the trace body.
   A per-relay egress proof, not a load-balancer ping.
5. Target not in the allowlist (`RELAY_ALLOWED_TARGETS`, default
   `https://opencode.ai`, `https://api.kilo.ai`) = `403 {"error":"Forbidden target"}`.
   The allowlist covers every hop: upstream `3xx` redirects are refused
   (`502`), so an allowlisted origin cannot steer the relay elsewhere.

## Header protocol

| Header | Required | Meaning |
| --- | --- | --- |
| `x-relay-target` | no | Upstream origin, trailing `/` stripped. Absent = health check. |
| `x-relay-path` | no | Path appended to target. Default `/`. |

Minimal forward example (relay 1 on its bridge address):

```bash
curl -s -N http://10.244.0.100:3001/v1/models \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /zen/v1/models"
```

## Ingress options: TryCloudflare Quick Tunnels vs Mesh-VPN

### 1. TryCloudflare Quick Tunnels (`--with-tunnels`): Recommended for Easiest Setup

Running `./generate-compose.sh N --with-tunnels` pairs each relay port (`300N`) with a lightweight `cloudflare/cloudflared:latest` container (~18–20 MiB RAM).
- **Zero configuration:** No Cloudflare account, custom domain, API token, or router port-forwarding needed. Cloudflare automatically issues a secure public HTTPS URL ending in `.trycloudflare.com`.
- **Security allowlist:** Although the tunnel URLs are public, the relay router strictly rejects any request whose target is not in `RELAY_ALLOWED_TARGETS` (`opencode.ai`, `api.kilo.ai`) with `HTTP 403 Forbidden`.
- **URL stability:** Tunnels run as independent sibling containers. Rebuilding the relay app or restarting WARP clients (for 429 rotation) does **not** restart the tunnels or change their URLs.

### 2. Mesh-VPN Direct (Tailscale)

The `relay` service publishes `${INGRESS_BIND}:3101-<3100+N>` → container `3001-<3000+N>`, so `http://<tailscale-ip>:310N` reaches relay `:300N` over your private encrypted Tailscale network. `INGRESS_BIND` defaults to `127.0.0.1`; the wizard (`setup.sh`) sets it to the VPS Tailscale IP for mesh installs, and manual installs pass it explicitly (`INGRESS_BIND=<tailscale-ip> ./generate-compose.sh N`).
- **Static:** URLs never change across container recreations, host reboots, or updates.
- **Private:** No traffic passes over public tunnel endpoints.
## Why one port per relay (not a single load balancer)

- **Reasoning-issuer affinity:** reasoning models return encrypted
  reasoning decryptable only by the issuing egress IP. The client pins
  follow-up turns to the issuing relay; a blind load balancer would route
  turn 2 to a different egress and break the conversation.
- **Failure isolation:** one hot egress cools down one relay while the
  rest keep serving — behind one endpoint, a single 429 poisons everything.
- **Hedging:** the client can race a stalled relay against a second egress
  path; a single endpoint gives it nothing to race with.

## Why per-relay WARP egress

Each `warp-N` (minimal MicroWARP `warp-lite:latest`, `NET_ADMIN`) owns its
IPv6 egress `/128`, so upstream per-IP throttling (HTTP 429) hits one relay,
not the pool. IPv4 egress is Cloudflare CGNAT, shared across the pool; an
IPv4-only upstream can therefore throttle several relays at once, which is
what `GLOBAL_QUOTA_GUARD` and the duplicate-IP note in `get-status.sh` are
for. Rotating one `warp-N` buys a fresh egress address while every client
URL keeps working. That isolation is the whole pool design.
