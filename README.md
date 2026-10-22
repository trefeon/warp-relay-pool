# warp-relay-pool

Self-hosted Docker/MicroWARP egress relay pool for AI coding agents ([pi-freeflow](https://github.com/trefeon/pi-freeflow), OMP, Pi).

Provides N isolated Cloudflare WARP egress addresses paired with public HTTPS URLs via **Cloudflare Quick Tunnels (TryCloudflare)** or private static URLs via **Tailscale Mesh-VPN**. A background keep-cold prober automatically detects upstream HTTP 429 rate limits and rotates throttled WARP clients without changing your client URLs.

```
[OMP / Pi via pi-freeflow]
          │
          ├── TryCloudflare (Public HTTPS, zero client VPN) ──► https://<hash>.trycloudflare.com
          └── Tailscale (Private Mesh-VPN direct)           ──► http://<tailscale-ip>:310N
                    │
                    ▼
          [relay router :300N (10.244.0.100)]
                    │  (per-port SOCKS5 forward)
                    ▼
          [MicroWARP SOCKS :1080 (Docker bridge 10.244.0.0/16)]
                    │  (Alpine WireGuard + microsocks, ~1.8 MiB RAM/node)
                    ▼
          [Cloudflare Edge ──► Upstream API (opencode.ai / api.kilo.ai)]
```

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
5. **Keep-Cold Service:** Installs and enables the `warp-keep-cold.timer` systemd service to automatically probe and rotate rate-limited egress IPs every 5 minutes.
6. **Client Commands:** Prints ready-to-paste `/freeflow add` commands directly into your terminal.

---

## Sizing: Why 5 Relays is the Sweet Spot

For most users and developers running parallel coding subagents, **5 relays** is optimal:
- **5 Egress Paths:** Upstream rate limits (HTTP 429) are tracked per-IP per-model. Each WARP
  client gets its own IPv6 `/128`, so IPv6-capable upstreams see five isolated addresses.
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

## Connecting to Your Agent (`pi-freeflow`)

Once `./setup.sh` completes, copy the printed commands and paste them into your OMP or Pi agent chat:

```text
/freeflow add https://<hash-1>.trycloudflare.com relay-1
/freeflow add https://<hash-2>.trycloudflare.com relay-2
/freeflow add https://<hash-3>.trycloudflare.com relay-3
/freeflow add https://<hash-4>.trycloudflare.com relay-4
/freeflow add https://<hash-5>.trycloudflare.com relay-5
```

Then manage your pool in agent chat:
- `/freeflow status` — check all configured relays and their active health
- `/freeflow test` — run real upstream streaming inference tests across all relays
- `/freeflow spread` — distribute parallel subagent tasks across all relays simultaneously

---

## Security Model (Safe for Public Internet)

Even when exposed over public TryCloudflare HTTPS URLs, the relay is strictly protected:
- **Strict Target Allowlist:** The relay router (`server.mjs`) strictly enforces `RELAY_ALLOWED_TARGETS` (`https://opencode.ai`, `https://api.kilo.ai` by default).
- Requests to any other origin (or malicious targets) return **HTTP 403 Forbidden** immediately.
- Only inference streaming requests conforming to the `x-relay-target` protocol are forwarded.

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
| `docs/` | Step-by-step technical guides (01–05) |
| `warp-lite/` | Minimal MicroWARP image source (Alpine WireGuard + microsocks, ~1.8 MiB runtime) |

---

## Security & Privacy

Repository privacy rules — no live tunnel URLs, egress IPs, account IDs, tokens, emails, or private host addresses are ever committed; docs use `<RELAY-N-URL>` / `<EGRESS-IP>` / `<tailscale-ip>`, and `*.trycloudflare.com` always means the Quick Tunnel domain pattern — plus the full security model and vulnerability reporting live in [SECURITY.md](SECURITY.md).
