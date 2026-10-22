# 05 — Troubleshooting / FAQ

**Mesh-VPN URLs never change.** In default (pure) mode there are no tunnel
containers, so container restarts, daemon reboots, and relay rebuilds keep
every `http://<tailscale-ip>:310N` line working. If a mesh-VPN URL stops
working, the fault is ingress-side (relay app down, host offline, tailnet
split) — check `docker logs warp-relay-app` and host reachability, not
egress rotation.

**Tunnel URL changed (tunnels mode only).** Expected after any `tunnel-N`
restart or host reboot — Quick Tunnels are ephemeral. Re-run
`./get-status.sh` and re-paste the `/freeflow add <RELAY-N-URL> relay-N`
lines. Never restart `tunnel-N` for a throttled relay; that trades a
per-egress 429 for a pool-wide URL churn. See [04](04-operations-keep-cold.md).
Relay rebuilds can't cause this: tunnels carry no `depends_on: - relay`.

**403 `Forbidden target`.** `x-relay-target` is not in the allowlist
(`RELAY_ALLOWED_TARGETS`, default `https://opencode.ai`,
`https://api.kilo.ai`). Fix the header (a trailing `/` is stripped for you)
or set the env and re-run
`./generate-compose.sh <count> [--with-tunnels] && docker compose up -d`
(the generator bakes the allowlist into the relay service environment;
editing `.env` alone rebuilds nothing).

**Mesh-VPN relay URLs skipped by the client.** A pi-freeflow build without
mesh-VPN peer relay support accepts https-only relay URLs and silently
skips plain-http mesh addresses (falling back to direct mode, which
rate-limits). Upgrade the client, or use Quick-Tunnel URLs instead.

**429 on one relay, one model.** Normal per-model-per-egress throttle —
another relay or model on the same relay still serves. Either wait or
`docker restart warp-relay-warp-N`; keep-cold does this automatically
when the timer is installed. 429 on nearly every relay for one model =
upstream quota (`GLOBAL_QUOTA_GUARD`), no rotation helps.

**Stale code after editing `server.mjs`.** The image is `COPY`-baked:
`docker compose restart relay` re-runs old code. Always
`docker compose build relay && docker compose up -d relay`.

**Containers not ready / `(not ready)`.** WARP clients
need a minute to handshake after `up` or rotation. Check per layer:
`docker logs warp-relay-warp-N` (client state), in tunnels mode `docker logs
warp-relay-tunnel-N` (edge URL line appears only once connected),
`curl -s http://10.244.0.100:300N/` (relay + SOCKS path without mesh or
tunnel). One relay red = its `warp-N`; all red = relay app or host
network. `warpReady` in `keep-cold.mjs` gates rotation on Connected +
real egress for exactly this reason.

**Host port already in use.** If `docker compose up` fails binding `310N`
or `10800+N` (a local service already claims it — `:3102` or `:10802`
collisions are the classic case), pick a free range and edit the `ports:` lines in
`docker-compose.yml` (or the generator), then `up` again. Client lines use
whatever host ports you publish.

**Multi-stack or systemd failures.** Check systemd logs with
`journalctl -u warp-keep-cold.service -n 50 --no-pager` or `journalctl -u docker`.
If containers stop unexpectedly, inspect exit codes with
`docker inspect <container> --format "exit={{.State.ExitCode}} oom={{.State.OOMKilled}}"`.
