# 06 — Universal proxy mode

Closed mode (exact origins in `RELAY_ALLOWED_TARGETS`, no token) is the
default and covers the pi-freeflow lane. Universal mode widens one pool to
arbitrary upstreams: wildcard/suffix/regex allowlist entries plus a shared
token. Additive only — closed mode, keep-cold, and the probe path are
untouched.

## Allowlist entries

`RELAY_ALLOWED_TARGETS` is a comma list. Each entry matches against the
request **origin**:

| Entry | Matches |
| ----- | ------- |
| `https://opencode.ai` | That exact origin only |
| `*` | Any `http`/`https` origin |
| `*.example.com` | The apex plus all subdomains |
| `re:^https://[a-z0-9-]+\.example\.com$` | Anchored JS regex on the origin |

## Token setup

`RELAY_AUTH_TOKEN` empty/unset means disabled. When set, requests whose
target matched **only** via a wildcard (`*`, `*.suffix`) or `re:` entry
must carry `x-relay-auth: <token>` or they get `401`. Exact-origin matches
never require it, and the no-target health check is always exempt.
`x-relay-auth` is stripped before upstream (never forwarded).

A wildcard/regex entry **requires** `RELAY_AUTH_TOKEN` — without it anyone
who can reach the listener proxies anywhere. Pass the token via host env
only; never commit it:

```sh
RELAY_AUTH_TOKEN=<token> ./generate-compose.sh 5 [--with-tunnels]
docker compose up -d --build
```

Regenerate after changing either variable — both are baked into the relay
service environment at generation time.

## Request shapes

All three go through the same per-relay SOCKS5 egress. Origin confinement
(allowlist match on every hop) and redirect refusal (upstream `3xx`
refused with `502`) apply unchanged in every mode.

Standard closed-mode headers (works in both modes for exact origins):

```sh
curl -s -N http://<tailscale-ip>:3101/v1/models \
  -H "x-relay-target: https://opencode.ai" \
  -H "x-relay-path: /zen/v1/models"
```

Standard forward-proxy form — absolute URI, no `x-relay-target` needed.
The relay derives target + path from `req.url`:

```sh
curl -s -N -x http://<tailscale-ip>:3101 http://example.com/v1/models \
  --proxy-header "x-relay-auth: <token>"
```

`CONNECT` tunnel (HTTPS through the relay). Host:port is restricted to
ports `443`/`80` and the hostname is matched against the allowlist as an
`https` origin. On success the relay answers `200` and splices a raw TCP
pipe over the SOCKS-connected socket — no interception, no re-encryption —
released when the connection closes:

```sh
curl -s -N -x http://<tailscale-ip>:3101 https://example.com/v1/models \
  --proxy-header "x-relay-auth: <token>"
```

(`--proxy-header` attaches `x-relay-auth` to the `CONNECT` request itself;
omit it for exact-origin targets when no token is configured.)

## Exposure warning

Universal mode widens what the relay *can* reach, so narrow who can reach
the relay:

- Keep `WARP_BIND` / `INGRESS_BIND` on loopback, or bind `INGRESS_BIND`
  to the Tailscale IP (mesh-VPN clients only). Never publish `3100+N` or
  `10800+N` to the open internet.
- In tunnels mode the router is not host-published; each tunnel URL is a
  public capability — treat tunnel URLs as secrets once a wildcard entry
  exists, and rotate the token by regenerating (`RELAY_AUTH_TOKEN=<new>
  ./generate-compose.sh … && docker compose up -d --build relay`).
- Quota note: 429 rotation and the keep-cold probe lane still target
  `PROBE_TARGET` (OpenCode Zen) only — universal traffic rides the same
  egress IPs but does not extend probing to new upstreams.
