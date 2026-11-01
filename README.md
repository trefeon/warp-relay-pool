# warp-relay-pool

Self-hosted WARP egress relay pool — one stack, two modes. N isolated
Cloudflare WARP egress addresses with public HTTPS URLs via **Cloudflare
Quick Tunnels (TryCloudflare)** or private static URLs via **Tailscale
Mesh-VPN**, fronted by a per-port relay router.

```
[any HTTP client via universal mode] ──┐
                                       ├──► [relay router :300N (10.244.0.100)]
[OMP / Pi via pi-freeflow] ────────────┘         │  (per-port SOCKS5 forward)
                                                 ▼
                                       [MicroWARP SOCKS :1080 (Docker bridge 10.244.0.0/16)]
                                                 │  (Alpine WireGuard + microsocks, ~1.8 MiB RAM/node)
                                                 ▼
                                       [Cloudflare Edge ──► upstream API, egress <EGRESS-IP>]
```

## Which track am I? (<60s)

|  | Track A — Independent universal proxy | Track B — Specialized pi-freeflow pool |
|---|---|---|
| You are | Any HTTP client; you bring your own upstream | OMP/Pi user driving [pi-freeflow](https://github.com/trefeon/pi-freeflow) |
| You get | Any upstream via allowlist + token, forward-proxy + `CONNECT`, own egress IPs, per-egress quota notes | Self-hosted WARP egress for OMP/Pi, keep-cold 429 rotation, `/freeflow` commands |
| You run | `RELAY_AUTH_TOKEN=<token> ./generate-compose.sh 5 --with-tunnels` | `./setup.sh`, then paste the printed `/freeflow add` lines |
| Detail lives | [docs/06-universal-proxy.md](docs/06-universal-proxy.md) — entry shapes, `CONNECT` / absolute-form, token setup | [docs/03-use-with-pi-freeflow.md](docs/03-use-with-pi-freeflow.md) — add/status/test/spread, health curls |

How it works for both tracks: [docs/01-overview-how-it-works.md](docs/01-overview-how-it-works.md).
Deploy paths for both ingress modes below; operations in [docs/](docs/README.md).

---

## Quickstart: One-Command Auto Setup

Deploy on any Linux VPS with systemd (Ubuntu, Debian, Fedora, CentOS):

```bash
git clone https://github.com/trefeon/warp-relay-pool.git
cd warp-relay-pool
./setup.sh
```

Or run non-interactively with auto-detected sizing recommendations:
```bash
./setup.sh -y
```

### What the Setup Wizard Does:
1. **Prerequisite Check & Auto-Install:** Verifies and automatically installs Docker, Docker Compose, and Node.js 18+ (for the prober) if missing.
2. **Hardware Sizing:** Detects VPS RAM and CPU cores, recommends safe relay limits, and defaults to the **5-relay sweet spot**.
3. **MicroWARP Build:** Builds the ultra-lightweight WireGuard + microsocks engine (~1.8 MiB RAM per relay).
4. **TryCloudflare Tunnel Wiring:** Automatically exposes each relay on a public HTTPS URL without requiring any Cloudflare account, domain name, or open inbound firewall ports.
5. **Keep-Cold Sweep:** Installs `warp-keep-cold.timer` — a systemd service that scans every relay
   every 5 minutes (≤ 10 relays) or 15 minutes (> 10 relays). Any relay returning HTTP 429 is
   restarted onto a fresh `/64` egress and re-probed until it streams again. Pool is "safe" once
   at least half the relays are clean (10 of 20). No time cap on rotation — just attempt-bounded.
6. **Client Commands:** Prints ready-to-paste `/freeflow add` commands directly into your terminal.

---

## Sizing: Why 5 Relays is the Sweet Spot

For most users and developers running parallel coding subagents, **5 relays** is optimal:
- **5 Egress Paths:** Upstream rate limits (HTTP 429) are tracked per-model per-egress `/64` block.
  The keep-cold controller automatically verifies that rotations acquire a fresh `/64` prefix
  block, escalating from soft restarts (zero Cloudflare registrations) to full re-keys only when
  the address block fails to change.
  IPv4-only upstreams see Cloudflare's shared CGNAT pool, which is why the prober rotates on
  batches and the status table flags duplicate egress IPs.
- **Ultra-Low Memory Consumption:**
  - With **TryCloudflare Quick Tunnels**: ~160 MB total RAM (fits comfortably on any 512 MB or 1 GB VPS).
  - With **Tailscale Mesh-VPN**: ~50 MB total RAM.
- **Auto-Recovery:** If one relay hits a rate limit, the background controller rotates that single container's egress IP while the remaining 4 relays continue serving turns seamlessly.

| VPS Plan | Ingress Mode | Recommended Relays | Total Stack Memory |
|---|---|---|---|
| **512 MB VPS** | TryCloudflare Tunnels | 5 relays | ~160 MB |
| **512 MB VPS** | Tailscale Mesh-VPN | 5 – 10 relays | ~50 – 60 MB |
| **1 GB VPS** | TryCloudflare Tunnels | 5 – 10 relays | ~160 – 270 MB |
| **2 GB+ VPS** | TryCloudflare Tunnels | 10 – 20 relays | ~270 – 490 MB |

---

## Connecting to Your Agent (Track B)

`./setup.sh` prints ready-to-paste lines; full client flow (add, status,
test, spread, health curls, allowlist) lives in
[docs/03-use-with-pi-freeflow.md](docs/03-use-with-pi-freeflow.md):

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
```

---

## Security Model (Safe for Public Internet)

Applies to both tracks; full model and reporting in [SECURITY.md](SECURITY.md):
- **Closed default (403):** the relay router (`server.mjs`) enforces
  `RELAY_ALLOWED_TARGETS` (`https://opencode.ai`, `https://api.kilo.ai`,
  `https://oai.endpoints.kepler.ai.cloud.ovh.net`). Any other origin
  returns **HTTP 403 Forbidden**; upstream `3xx` redirects are refused
  (`502`), so an allowlisted origin cannot steer the relay elsewhere.
- **Wildcard-requires-token boundary (401):** wildcard/suffix/regex entries
  (`*`, `*.suffix`, `re:…`, see [docs/06-universal-proxy.md](docs/06-universal-proxy.md))
  widen the relay to arbitrary origins, so matches via wildcard alone must
  carry `x-relay-auth: <token>` (else **401**; exact-origin matches never
  need it, health check exempt). A wildcard entry with no
  `RELAY_AUTH_TOKEN` configured is an open proxy for anyone who can reach
  the listener.
- **Bind guidance:** keep `3100+N` on loopback or the Tailscale IP; never
  publish relay ports to the open internet. `x-relay-auth` is stripped and
  never forwarded.
- **Tunnel-URL-as-capability:** anyone holding a relay URL can make
  allowlisted upstream requests through that relay's egress IP and read
  that egress IP from the health check — treat relay URLs as sensitive
  even though TryCloudflare URLs are public by construction.

---

## Universal Proxy Mode (Track A)

Closed mode above is the default. Track A detail (allowlist entry shapes,
`RELAY_AUTH_TOKEN` / `x-relay-auth`, `CONNECT` / absolute-form usage, quota
and egress notes) lives in [docs/06-universal-proxy.md](docs/06-universal-proxy.md).

---

## Manual Deployment

If you prefer manual control over the compose generation and lifecycle:

### Option A: TryCloudflare Quick Tunnels (Zero VPN required)
```bash
./generate-compose.sh 5 --with-tunnels
docker compose up -d --build
./get-status.sh
```

### Option B: Tailscale Mesh-VPN Direct
```bash
# The router defaults to 127.0.0.1; bind it to the tailnet address so the
# documented http://<tailscale-ip>:310N URLs are actually reachable.
INGRESS_BIND=$(tailscale ip -4) ./generate-compose.sh 5
docker compose up -d --build
./get-status.sh
```

---

## Rotation Rule: Warp-Only

When a relay gets throttled (HTTP 429), **only restart its `warp-N` container**:
```bash
docker restart warp-relay-warp-1
```
- **Never restart `tunnel-N` or `relay`**:
  - Restarting `tunnel-N` generates a new `.trycloudflare.com` URL, breaking configured client lines.
  - Restarting `relay` drops active connections across all relays.
- Restarting `warp-N` acquires a fresh Cloudflare egress IP while keeping your public tunnel URL and relay port completely stable.
- The automated monitor (`keep-cold.mjs`) follows this rule strictly.

To run a single probe pass manually:
```bash
node keep-cold.mjs --once
```

---

## File Map

| File | Role |
| ---- | ---- |
| `setup.sh` | Interactive and non-interactive auto-setup wizard with VPS hardware sizing |
| `server.mjs` | Relay router: allowlist proxy, one listener per `300N`, SSE/no-buffer streaming |
| `keep-cold.mjs` | Two-tier 429 prober / rotator for MicroWARP backends (`--once` or `--loop`) |
| `docker-compose.yml` | N × MicroWARP + relay app; tunnels appended only by `--with-tunnels` |
| `Dockerfile` / `package.json` | Relay image (COPY-baked) / dependencies |
| `generate-compose.sh` | Regenerate `docker-compose.yml`: `[count] [--with-tunnels] [--legacy-warp]` |
| `get-status.sh` | Status script: prints public tunnel URLs, egress IPs, client commands |
| `systemd/` | systemd service units and timers for keep-cold and logwatch |
| `docs/` | Step-by-step technical guides (01–06) |
| `warp-lite/` | Minimal MicroWARP image source (Alpine WireGuard + microsocks, ~1.8 MiB runtime) |

---

## Security & Privacy

Repository privacy rules — no live tunnel URLs, egress IPs, account IDs, tokens, emails, or private host addresses are ever committed; docs use `<RELAY-N-URL>` / `<EGRESS-IP>` / `<tailscale-ip>`, and `*.trycloudflare.com` always means the Quick Tunnel domain pattern — plus the full security model and vulnerability reporting live in [SECURITY.md](SECURITY.md).
