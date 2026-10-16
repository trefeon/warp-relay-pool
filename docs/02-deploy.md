# 02 — Deploy

Runs on a Docker Linux host (needs `NET_ADMIN` for WARP; not Windows).
Prereqs: `docker compose` and `node` (node only for `keep-cold.mjs`).
For mesh-VPN ingress, the host must already be joined to your tailnet.

## Quickest: Automated Setup Wizard

```bash
./setup.sh
```

The interactive wizard handles everything automatically:
- Checks and installs missing prerequisites (Docker, Docker Compose, Node.js).
- Detects VPS RAM and CPU cores, recommends safe relay limits, and defaults to the **5-relay sweet spot** (~140 MB total RAM).
- Builds the minimal MicroWARP image (`warp-lite:latest`, ~1.8 MiB RAM/node).
- Deploys TryCloudflare Quick Tunnels (public HTTPS URLs, zero client VPN needed) or Mesh-VPN direct.
- Installs the `warp-keep-cold.timer` systemd service for automatic 429 rate-limit recovery.
- Prints the copy-paste `/freeflow add` commands ready for your agent.

To run non-interactively with auto-detected recommendations:
```bash
./setup.sh -y
```

---

## Manual Deployment

### Option A: TryCloudflare Quick Tunnels (Recommended for public access)

```bash
./generate-compose.sh 5 --with-tunnels
docker compose up -d --build # ~140 MiB resident total for 5 relays + tunnels
./get-status.sh              # prints live public tunnel URLs + client commands
```

### Option B: Mesh-VPN Direct (Tailscale)

```bash
./generate-compose.sh 5     # pure mode: MicroWARP + relay, no tunnels
docker compose up -d --build # ~50 MiB resident total for 5 relays
./get-status.sh              # ports, egress IPs, mesh-VPN client commands
```
`get-status.sh [count]` (default `COUNT` env, else 10) reads live state
off the host: egress IPs from
`docker exec warp-relay-warp-N curl …/cdn-cgi/trace`, tunnel URLs from
`docker logs warp-relay-tunnel-N`. Its output is host-only — never commit it.

## Rescale to N relays

```bash
./generate-compose.sh <N> [--with-tunnels]  # rewrites docker-compose.yml, RELAY_COUNT=N
docker compose up -d --build
```

Topology is fixed by the generator: bridge `10.244.0.0/16`, relay app at
`10.244.0.100`, `tunnel-N → http://10.244.0.100:300N` (tunnels mode only),
`warp-N` on `:1080` (raw proxy on host `<10800+N>`; loopback by default).
Host binds default to loopback; override with `WARP_BIND=<addr>` (SOCKS
family) and `INGRESS_BIND=<addr>` (relay router, mesh mode only — tunnels
mode does not host-publish the router at all). The wizard sets
`INGRESS_BIND` to the VPS Tailscale IP automatically. Binds are IPv4 only;
an interface-specific `WARP_BIND` (not `127.0.0.1`/`0.0.0.0`) needs
`SOCKS_HOST=<addr>` for keep-cold's probes (`get-status.sh` reads the bind
from the compose file itself).
`WARP_HOST_N` / `WARP_PORT_N` env overrides exist in `server.mjs` but the
default naming needs no configuration.

## Keep-cold timer (systemd)

```bash
node keep-cold.mjs --once      # one pass now; exit 0 when all clean
sudo cp systemd/warp-keep-cold.{service,timer} /etc/systemd/system/
# edit paths to your checkout first, then:
sudo systemctl enable --now warp-keep-cold.timer
```

The service is `Type=oneshot` with `TimeoutStartSec=900` (a pass can
rotate several relays, each waiting for WARP re-handshake) and `flock -n`
so overlapping timer fires never stack. The timer fires every 5 minutes
(`OnCalendar`). Without `--loop`, one pass = one timer fire.
See [04](04-operations-keep-cold.md) for tuning (notably
`GLOBAL_QUOTA_GUARD`).

## Rebuild, don't restart

The relay image is `COPY`-baked (`Dockerfile` copies `server.mjs` at build
time). After editing `server.mjs`:

```bash
docker compose build relay && docker compose up -d relay
```

A plain `docker compose restart relay` re-runs the stale baked code.
No edit → no rebuild needed; container `restart: always` covers reboots.
Tunnels (when present) are unaffected: they carry no `depends_on: - relay`,
so relay rebuilds never cascade-restart them.
