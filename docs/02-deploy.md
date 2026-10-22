# 02 — Deploy

Runs on a Docker Linux host (needs `NET_ADMIN` for WARP; not Windows).
Prereqs: `docker compose`, `node >= 18` for `keep-cold.mjs` (the test suite
and the relay image use Node 22), and systemd for the timers. For mesh-VPN ingress, the host must already be joined to
your tailnet. `setup.sh` may install Docker and Node itself; if the invoking
user is not yet in the `docker` group, the wizard re-executes under `sudo`.

## Quickest: Automated Setup Wizard

```bash
./setup.sh
```

The interactive wizard handles everything automatically:
- Checks and installs missing prerequisites (Docker, Docker Compose, Node.js).
- Detects VPS RAM and CPU cores, recommends safe relay limits, and defaults to the **5-relay sweet spot** (~160 MB total RAM).
- Builds the minimal MicroWARP image (`warp-lite:latest`, ~1.8 MiB RAM/node).
- Deploys TryCloudflare Quick Tunnels (public HTTPS URLs, zero client VPN needed) or Mesh-VPN direct.
- Installs the `warp-keep-cold.timer` and `warp-logwatch.timer` systemd units.
- On an existing deployment, adopts the deployed relay count and ingress
  mode unless `COUNT=`/`INGRESS=` are pinned (and removes orphan containers
  when the pool shrinks).
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
docker compose up -d --build # ~160 MiB resident total for 5 relays + tunnels
./get-status.sh              # prints live public tunnel URLs + client commands
```

### Option B: Mesh-VPN Direct (Tailscale)

```bash
# Bind the router to the tailnet address, not loopback.
INGRESS_BIND=$(tailscale ip -4) ./generate-compose.sh 5
docker compose up -d --build # ~50 MiB resident total for 5 relays
./get-status.sh              # ports, egress IPs, mesh-VPN client commands
```
`get-status.sh [count]` (default `COUNT` env, else 10) reads live state
off the host and prints the port a client actually dials (`310N` when the
router is host-published, otherwise the in-network `300N` marked `*`).
Egress IPs come primarily via the host-side SOCKS probe
(`curl -x socks5h://127.0.0.1:<10800+N>` against that relay's WARP
egress, with a `docker exec warp-relay-warp-N curl …/cdn-cgi/trace`
fallback), tunnel URLs from `docker logs warp-relay-tunnel-N`. Its
output is host-only — never commit it.

## Rescale to N relays

```bash
./generate-compose.sh <N> [--with-tunnels] [--legacy-warp]  # rewrites docker-compose.yml, RELAY_COUNT=N
docker compose up -d --build --remove-orphans
```

The project name is the checkout directory name, so re-deploy in the same
directory to keep the `warp-data-N` volumes (they hold the WARP
registrations; new names mint new registrations). Shrinking the pool leaves
the removed `warp-relay-pool_warp-data-<N>` volumes behind — remove them
with `docker volume rm` once you are sure the extra egress identities are
not needed.

`--legacy-warp` swaps the minimal MicroWARP image for
`caomingjun/warp:latest` (~100 MiB per relay instead of ~1.8 MiB). Every
sizing figure in this repo assumes warp-lite — with this flag a 5-relay
pool needs >500 MiB, so do not pick it on a 512 MB VPS.

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
node keep-cold.mjs --once      # one pass now; exit 0 only when every relay is clean
sudo cp systemd/warp-keep-cold.{service,timer} /etc/systemd/system/
# edit User=/WorkingDirectory=/ExecStart= AND Environment=COUNT=/BASE_PORT=
# to match the deployed pool (setup.sh does this automatically), then:
sudo systemctl daemon-reload
sudo systemctl enable --now warp-keep-cold.timer
```

The service is `Type=oneshot` with `TimeoutStartSec` sized for the first
baseline sweep (most relays may need one restart); later passes are short
because probing is demand-driven and a relay is restarted at most once per
`RELAY_COOLDOWN_S`. `flock -n -E 0` makes an overlapping timer fire
contention, not failure. The timer fires every 5 minutes (`OnCalendar`).
Without `--loop`, one pass = one timer fire.

Exit status: `0` = every relay clean; `1` = a relay is still hot, a
server_error held, a 502 did not recover, a relay was just rotated and is
still awaiting post-restart verification, or a model is throttled on
`GLOBAL_QUOTA_GUARD` relays (upstream quota — logged as
`quota-capped`, deliberately not rotated). See
[04](04-operations-keep-cold.md) for tuning.

## Error watcher (logwatch, optional)

`logwatch.sh` scrapes the relay/WARP container logs and the keep-cold
journal into `logs/errors.log` (rotated) and writes per-relay/day tallies
for rollover summaries; state lives in `logs/.cursor` / `.last` /
`.events`.

```bash
sudo cp systemd/warp-logwatch.{service,timer} /etc/systemd/system/
# edit User=/WorkingDirectory=/ExecStart= and Environment=COUNT= first
sudo systemctl daemon-reload
sudo systemctl enable --now warp-logwatch.timer   # every 2 minutes; flock-guarded
```

`Environment=COUNT` must match the deployed pool, and the service user must
read the Docker socket and the system journal (`SupplementaryGroups` in the
shipped unit grants `docker` and `systemd-journal`). Its suite is part of
CI: `bash logwatch.test.sh`.

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
