# 08 — MASQUE nodes (MicroWARP engine)

Optional second node engine. Default deployments are unchanged: `warp-lite`
(WireGuard + microsocks) stays the default and its generated
`docker-compose.yml` is byte-identical.

Use this engine when WireGuard cannot establish but TCP/443 to Cloudflare
works — e.g. a host behind a TSPU-style path where UDP/2408 is dropped. The
symptom is unambiguous: every `warp-N` container reports healthy, `warp=off`
in its trace, and 0/N nodes carry traffic, while `curl https://1.1.1.1` on
the same host succeeds.

## What changes

| | `warp-lite` (default) | `microwarp` (this doc) |
|---|---|---|
| Image | locally built `warp-lite:latest` | `ghcr.io/ccbkkb/microwarp:latest` |
| Transport | WireGuard UDP/2408 | usque, CONNECT-IP over HTTP/3 :443 |
| Rotation | restart (tier-1), re-key (tier-2) | restart only |
| Device identity | `warp-data-N` volume (`wg0.conf`) | `./state/warp-N/masque-config.json` |
| Privileges | `NET_ADMIN` | none in `socks` mode, `NET_ADMIN` in `l4-socks` |
| Resident memory | ~1.8 MiB/node | 5-7 MiB/node (measured `docker stats`) |

Unchanged: container names (`warp-relay-warp-N`), the in-network SOCKS
contract (`warp-N:1080`), host ports (`10800+N`), the relay app, the tunnels,
and the whole relay allowlist/auth surface. Nothing in `server.mjs` knows
which engine is behind a relay.

## Generate a MASQUE pool

```bash
docker pull ghcr.io/ccbkkb/microwarp:latest
./generate-compose.sh 10 --node-engine=microwarp
docker compose up -d
```

`--masque-proxy-mode` selects the usque listener:

- `socks` (default) — usque's userspace SOCKS5 proxy. One egress address per
  node (10/10 distinct measured), no `NET_ADMIN`, no TUN device.
- `l4-socks` — TUN-based, TCP only, needs `NET_ADMIN`. Measured 10 nodes
  collapsing IPv4 onto 4 shared Cloudflare exits, which defeats the
  one-egress-per-relay design; pick it only for a host that cannot run
  `socks` mode.

`--legacy-warp` and `--node-engine=microwarp` are mutually exclusive.

`setup.sh` offers the engine interactively and honours
`NODE_ENGINE=microwarp ./setup.sh -y` for unattended runs. It pulls the image
instead of building `warp-lite`.

## Register one device per node

Cloudflare issues one device identity per registration, and the pool's whole
point is one distinct egress per node, so each node gets its own config:

```bash
./register-node.sh 1        # node 1 of a fresh host
./register-node.sh 2        # …and so on
```

Three bootstrap tiers, first that applies wins:

1. **auto** — an already-running pool node carries the registration POST
   through its in-network SOCKS port (`socks5://warp-relay-warp-M:1080`).
   Covers node 2+ on a fresh host and every re-registration.
2. **explicit** — `--bootstrap socks5://host:port` for a host-side or CI
   proxy.
3. **zero-state** — node 1 of a fresh host has no node to borrow, and
   `api.cloudflareclient.com` is SNI-filtered on some paths. Register from
   the operator workstation instead:

   ```bash
   ./register-node.sh --print-registration 1     # prints the docker run line
   # run it where the API resolves, then bring the JSON back:
   ./register-node.sh --import-registration 1 config.json
   ```

   `--import-registration` validates the usque schema (`private_key`, `id`,
   `access_token`, `ipv4`, `ipv6`, `endpoint_v4`, `endpoint_v6`,
   `endpoint_pub_key`) before writing mode-0600.

Each run ends by recreating that node, waiting for its healthcheck, and
probing `https://www.cloudflare.com/cdn-cgi/trace` through the node's SOCKS
port, requiring `warp=on`.

Configs live in `./state/warp-N/masque-config.json`, are bind-mounted
read-only, and are gitignored. `--force` overwrites a config but leaves the
old device registered server-side (it still counts against the device limit).

## Verifying egress

The trace MUST go through the node's own SOCKS listener:

```bash
docker exec warp-relay-warp-3 curl -s -x socks5h://127.0.0.1:1080 \
  https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|warp)='
```

A plain `docker exec … curl` (no `-x`) leaves the container without the
tunnel: it reports the host's address with `warp=off`. `get-status.sh` and
`keep-cold.mjs` both route their in-container fallback through the SOCKS port
for exactly this reason (`EGRESS_TRACE_SOCKS_PORT`, default `1080`; `0`
restores the plain probe).

## Rotation

Restart is the only safe rotation primitive: deleting
`masque-config.json` destroys the device registration. `keep-cold.mjs` detects
the missing `wg0.conf` and:

- treats tier-2 as a plain restart that spends no Cloudflare registration,
- never escalates a MASQUE node to a re-key,
- never aborts `--fresh-ip-sweep` or `--reset-until-clean` because a node has
  no `wg0.conf` (it reports the WireGuard/MASQUE split in preflight instead).

A fresh MASQUE prefix can come up already throttled: the upstream answers 429
with `FreeUsageLimitError` and a retry-after measured in hours (counting down
to the daily reset). No rotation can outlast that, so a 429 whose retry-after
exceeds `RETRY_AFTER_GIVE_UP_S` (default 900 s) parks the relay until the
window expires instead of restarting it in a loop — the 22 restarts/hour/node
measured on an unpatched keep-cold. Set `RETRY_AFTER_GIVE_UP_S=0` to restore
unconditional rotation.

Rotation moves the IPv6 prefix, not the IPv4 address: the device keeps its
`ipv4` field across restarts.

## Reboot behaviour

Every service is `restart: always` and the device configs live on disk, so a
reboot recovers the pool with no re-registration.

## Known limitations

- The image is pinned by tag, not digest — pin it yourself if you need
  reproducibility.
- A host whose SNI filter blocks `api.cloudflareclient.com` needs the
  workstation tier for the first node.
- `l4-socks` shares IPv4 exits between nodes (see above).
