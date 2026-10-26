# Docs

Numbered user journey. Read in order.

1. [01 — Overview: how it works](01-overview-how-it-works.md) — request
   lifecycle, `x-relay-target` / `x-relay-path` protocol, mesh-VPN vs
   Quick-Tunnel ingress, why one port per relay, why per-relay WARP egress.
2. [02 — Deploy](02-deploy.md) — prereqs, pure vs `--with-tunnels` deploy,
   `docker compose up`, systemd keep-cold install, rescale with
   `generate-compose.sh`, port collisions, rebuild gotcha.
3. [03 — Use with pi-freeflow (OMP/Pi client)](03-use-with-pi-freeflow.md) —
   `get-status.sh` → `/freeflow add`, mesh-VPN client requirement,
   health-check curls, allowlist.
4. [04 — Operations: keep-cold](04-operations-keep-cold.md) — probe/rotate
   logic, tunable env table, quota-guard tuning, warp-only rule, logs.
5. [05 — Troubleshooting / FAQ](05-troubleshooting-faq.md) — URL changed,
   403, 429, mesh URLs skipped, port collisions, stale image, not-ready containers.
6. [06 — Universal proxy mode](06-universal-proxy.md) — wildcard/suffix/regex
   allowlist entries, `RELAY_AUTH_TOKEN` setup, `CONNECT` / absolute-form
   usage, open-proxy warning and bind guidance.

Privacy: live tunnel URLs and egress IPs never enter this repo — use
`<RELAY-N-URL>` / `<EGRESS-IP>` / `<tailscale-ip>`. Real addresses live only
in host `get-status.sh` output. `*.trycloudflare.com` below means the Quick Tunnel
domain pattern, never a live address. Canonical rules: [SECURITY.md](../SECURITY.md).
