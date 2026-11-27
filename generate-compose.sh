#!/bin/sh
# Generate docker-compose.yml for N relays.
#
# Usage: ./generate-compose.sh [count] [--with-tunnels] [--legacy-warp]
#        [--node-engine=warp-lite|microwarp] [--masque-proxy-mode=socks|l4-socks]
#   count: integer 1..64 (default COUNT env, else 10)
#
# Default (pure) mode: warp-1..N on minimal MicroWARP (warp-lite: ~1.8 MiB RAM each),
# each with `ports: "<10800+i>:1080"` (raw proxy), plus one relay app at 10.244.0.100
# with `ports: "3101-<3100+N>:3001-<3000+N>"` for mesh-VPN direct ingress.
# With --with-tunnels: appends tunnel-1..N (Quick Tunnel -> http://10.244.0.100:300N).
# With --legacy-warp: uses caomingjun/warp:latest (~100 MiB each) instead of warp-lite.
# With --node-engine=microwarp: uses ghcr.io/ccbkkb/microwarp:latest (MASQUE over
# HTTP/3 via usque) instead of the locally built warp-lite image, for hosts where
# WireGuard UDP cannot establish. Each node reads its own device config from
# ./state/warp-<i>/masque-config.json (see docs/08-masque-nodes.md). Mutually
# exclusive with --legacy-warp.
# --masque-proxy-mode picks the MicroWARP listener (ignored by warp-lite):
# socks (default) exposes usque SOCKS5 on the container's port 1080 and keeps one
# egress address per node; l4-socks drives a TUN device (needs NET_ADMIN) and
# collapses IPv4 traffic onto shared Cloudflare exits.
#
# The warp-lite image is NOT built by Compose: every warp-N service references
# `image: warp-lite:latest` and no service declares a build context, so Compose
# cannot start several concurrent builds of the same tag (which failed with
# `AlreadyExists: image "warp-lite:latest" already exists`). Build it once:
#   docker build -t warp-lite:latest ./warp-lite
# setup.sh does that for you; manual deployments must run it before `up`.
# Rotation rule: restart warp-N only, never tunnel-N/relay.
set -eu

# Load .env when present. Only KEY=VALUE lines with shell-safe key names are
# applied, and values already present in the process environment win — so
# `COUNT=5 ./generate-compose.sh` and setup.sh prompts are never overridden.
# The relevant values are baked into the generated compose file, which is why
# editing .env alone changes nothing until this script runs again.
if [ -f .env ]; then
  cr="$(printf '\r')"
  dq='"' # quote characters, so the case patterns need no escapes
  sq="'"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    # A value-less line is not a KEY=VALUE assignment — skip it instead of
    # self-assigning KEY=KEY.
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # Windows-authored files may carry CRLF: a stray CR in a baked value
    # (URL, comma-list) would silently break matching downstream.
    val="${val%"$cr"}"
    # Shell-identifier keys only; a leading digit would alias positional
    # parameters or die under `set -u` despite the skip contract.
    case "$key" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
    case "$val" in
      "$dq"*) val="${val#"$dq"}"; val="${val%%"$dq"*}" ;;
      "$sq"*) val="${val#"$sq"}"; val="${val%%"$sq"*}" ;;
      # Bare values follow compose's env-file behaviour: a whitespace-preceded
      # `#…` starts an inline comment and is stripped. Quoted values run up to
      # the closing quote, with any trailing comment ignored; a ` #` inside the
      # quotes is part of the value.
      *) val="${val%%[[:space:]]#*}" ;;
    esac
    # shellcheck disable=SC2163,SC2086 # key is validated above
    eval "cur=\${$key:-}"
    [ -n "$cur" ] || export "$key=$val"
  done < .env
fi

COUNT="${COUNT:-10}"
WITH_TUNNELS=false
USE_LITE=true
NODE_ENGINE="${NODE_ENGINE:-warp-lite}"
MASQUE_MODE="${MASQUE_MODE:-socks}"
for arg in "$@"; do
  case "$arg" in
    --with-tunnels) WITH_TUNNELS=true ;;
    --legacy-warp) USE_LITE=false ;;
    --node-engine=*) NODE_ENGINE="${arg#*=}" ;;
    --masque-proxy-mode=*) MASQUE_MODE="${arg#*=}" ;;
    *) COUNT="$arg" ;;
  esac
done

case "$NODE_ENGINE" in
  warp-lite|microwarp) ;;
  *)
    echo "error: --node-engine must be warp-lite or microwarp, got '$NODE_ENGINE'" >&2
    exit 1
    ;;
esac
case "$MASQUE_MODE" in
  socks|l4-socks) ;;
  *)
    echo "error: --masque-proxy-mode must be socks or l4-socks, got '$MASQUE_MODE'" >&2
    exit 1
    ;;
esac
if [ "$NODE_ENGINE" = microwarp ] && [ "$USE_LITE" = false ]; then
  echo "error: --node-engine=microwarp and --legacy-warp are mutually exclusive" >&2
  exit 1
fi

case "$COUNT" in
  ''|*[!0-9]*)
    echo "error: COUNT must be an integer 1..64, got '$COUNT'" >&2
    exit 1
    ;;
esac
if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 64 ]; then
  echo "error: COUNT must be an integer 1..64, got '$COUNT'" >&2
  exit 1
fi
if [ "$WITH_TUNNELS" = true ]; then TUNNEL_FLAG=" --with-tunnels"; else TUNNEL_FLAG=""; fi
# The regenerate hint carries only non-default flags, so a default run keeps
# writing a byte-identical docker-compose.yml header.
if [ "$NODE_ENGINE" = microwarp ]; then ENGINE_FLAG=" --node-engine=microwarp"; else ENGINE_FLAG=""; fi
if [ "$MASQUE_MODE" = socks ]; then MASQUE_FLAG=""; else MASQUE_FLAG=" --masque-proxy-mode=$MASQUE_MODE"; fi

BASE_PORT="${BASE_PORT:-3000}"
case "$BASE_PORT" in
  ''|*[!0-9]*)
    echo "error: BASE_PORT must be an integer 1..65535, got '$BASE_PORT'" >&2
    exit 1
    ;;
esac
if [ "$BASE_PORT" -lt 1 ] || [ $((BASE_PORT + COUNT)) -gt 65535 ]; then
  echo "error: BASE_PORT+COUNT must be <= 65535, got $((BASE_PORT + COUNT))" >&2
  exit 1
fi
HOST_LO=$((3100 + 1))
HOST_HI=$((3100 + COUNT))
CONT_LO=$((BASE_PORT + 1))
CONT_HI=$((BASE_PORT + COUNT))

# Host binds default to loopback: the SOCKS proxies are unauthenticated and
# the relay router trusts anyone who can reach it. The relay app dials
# warp-N:1080 over the bridge and all shipped tooling probes 127.0.0.1, so
# only deliberate exposure needs WARP_BIND / INGRESS_BIND.
SOCKS_BIND="${WARP_BIND:-127.0.0.1}"
ROUTER_BIND="${INGRESS_BIND:-0.0.0.0}"
# IPv6 binds would need Compose's bracketed port syntax ("[::]:port:port"),
# which the templates below do not emit — reject rather than write a file
# Docker cannot parse.
case "$SOCKS_BIND$ROUTER_BIND" in
  ''|*[!0-9.]*)
    echo "error: WARP_BIND/INGRESS_BIND must be an IPv4 address; got WARP_BIND='$SOCKS_BIND' INGRESS_BIND='$ROUTER_BIND'" >&2
    exit 1
    ;;
esac
if [ "$WITH_TUNNELS" = true ]; then
ROUTER_LINE="relay router not host-published; tunnels reach it in-network at http://10.244.0.100:300N"
else
ROUTER_LINE="relay router (mesh-VPN ingress) on ${ROUTER_BIND}:${HOST_LO}-${HOST_HI} (override bind: INGRESS_BIND)"
fi

{
if [ "$NODE_ENGINE" = microwarp ]; then
cat <<MASQUE_HEADER
# Node engine: MicroWARP (MASQUE over HTTP/3 via usque) — docs/08-masque-nodes.md.
# Device config per node: ./state/warp-<i>/masque-config.json (provision with
# ./register-node.sh <i>); configs hold private keys and stay out of git.
MASQUE_HEADER
fi
cat <<HEADER
# Generated by ./generate-compose.sh — do not hand-edit.
# Regenerate: ./generate-compose.sh ${COUNT}${TUNNEL_FLAG}${ENGINE_FLAG}${MASQUE_FLAG}   (COUNT 1..64, default 10)
# Topology: bridge 10.244.0.0/16, relay app fixed at 10.244.0.100.
# warp-N raw SOCKS5 proxy on ${SOCKS_BIND}:<10800+N> (override bind: WARP_BIND),
# ${ROUTER_LINE}.
# Relay app env (RELAY_COUNT, BASE_PORT, RELAY_ALLOWED_TARGETS,
# RELAY_AUTH_TOKEN, LIVE_SIGNALS, LIVE_SIGNAL_FILE) is baked from the
# generation-time environment / .env —
# regenerate after editing either.
# The relay app bind-mounts ./.keep-cold at /signals so its 429 signal file
# lands in the same directory the host keep-cold reads (LIVE_SIGNALS=1).
networks:
  default:
    ipam:
      config:
        - subnet: 10.244.0.0/16

services:
HEADER

get_endpoint_for_index() {
  case "$(( ($1 - 1) % 10 ))" in
    0) echo "162.159.192.1:2408" ;;
    1) echo "162.159.193.1:2408" ;;
    2) echo "162.159.195.1:2408" ;;
    3) echo "188.114.96.1:2408" ;;
    4) echo "188.114.97.1:2408" ;;
    5) echo "188.114.98.1:2408" ;;
    6) echo "188.114.99.1:2408" ;;
    7) echo "162.159.192.2:2408" ;;
    8) echo "162.159.193.2:2408" ;;
    9) echo "162.159.195.2:2408" ;;
  esac
}

if [ "$NODE_ENGINE" = microwarp ]; then
i=1
while [ "$i" -le "$COUNT" ]; do
WARP_PORT=$((10800 + i))
# The bind-mount source must exist before `docker compose up`: a missing path
# makes Docker create a directory named masque-config.json.
mkdir -p "state/warp-${i}"
cat <<ENTRY
  warp-${i}:
    image: ghcr.io/ccbkkb/microwarp:latest
    container_name: warp-relay-warp-${i}
    restart: always
ENTRY
# socks mode is a userspace proxy and needs no privileges; l4-socks drives a TUN
# device, which does.
if [ "$MASQUE_MODE" = l4-socks ]; then
cat <<ENTRY
    cap_add:
      - NET_ADMIN
ENTRY
fi
cat <<ENTRY
    environment:
      - TUNNEL_PROTOCOL=masque
      - MASQUE_PROXY_MODE=${MASQUE_MODE}
      - BIND_ADDR=0.0.0.0
      - BIND_PORT=1080
      - ALLOW_NO_AUTH=1
      - ENABLE_IPV6=1
      - GOMEMLIMIT=256MiB
    volumes:
      - ./state/warp-${i}/masque-config.json:/etc/wireguard/masque-config.json:ro
    mem_limit: 48M
    mem_reservation: 16M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 1080"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
    ports:
      - "${SOCKS_BIND}:${WARP_PORT}:1080"

ENTRY
i=$((i + 1))
done
elif [ "$USE_LITE" = true ]; then
i=1
while [ "$i" -le "$COUNT" ]; do
WARP_PORT=$((10800 + i))
ENDPOINT_FOR_RELAY="$(get_endpoint_for_index "$i")"
cat <<ENTRY
  warp-${i}:
    image: warp-lite:latest
    container_name: warp-relay-warp-${i}
    restart: always
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
      - net.ipv6.conf.all.disable_ipv6=0
      - net.ipv6.conf.all.forwarding=1
    environment:
      - ALLOW_NO_AUTH=1
      - ENDPOINT_IP=${ENDPOINT_FOR_RELAY}
    volumes:
      - warp-data-${i}:/etc/wireguard
    mem_limit: 32M
    mem_reservation: 8M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "${SOCKS_BIND}:${WARP_PORT}:1080"

ENTRY
i=$((i + 1))
done
else
i=1
while [ "$i" -le "$COUNT" ]; do
WARP_PORT=$((10800 + i))
ENDPOINT_FOR_RELAY="$(get_endpoint_for_index "$i")"
cat <<ENTRY
  warp-${i}:
    image: caomingjun/warp:latest
    container_name: warp-relay-warp-${i}
    restart: always
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv6.conf.all.disable_ipv6=0
    environment:
      - ENDPOINT_IP=${ENDPOINT_FOR_RELAY}
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "${SOCKS_BIND}:${WARP_PORT}:1080"

ENTRY
i=$((i + 1))
done
fi

if [ "$WITH_TUNNELS" = true ]; then
cat <<ENTRY
  relay:
    build: .
    container_name: warp-relay-app
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    environment:
      - RELAY_COUNT=${COUNT}
      - BASE_PORT=${BASE_PORT:-3000}
      - RELAY_ALLOWED_TARGETS=${RELAY_ALLOWED_TARGETS:-https://opencode.ai,https://api.kilo.ai,https://oai.endpoints.kepler.ai.cloud.ovh.net}
      - RELAY_AUTH_TOKEN=${RELAY_AUTH_TOKEN:-}
      - LIVE_SIGNALS=${LIVE_SIGNALS:-0}
      - LIVE_SIGNAL_FILE=${LIVE_SIGNAL_FILE:-/signals/signals.json}
    volumes:
      - ./.keep-cold:/signals
    networks:
      default:
        ipv4_address: 10.244.0.100
    depends_on:
ENTRY
else
cat <<ENTRY
  relay:
    build: .
    container_name: warp-relay-app
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    environment:
      - RELAY_COUNT=${COUNT}
      - BASE_PORT=${BASE_PORT:-3000}
      - RELAY_ALLOWED_TARGETS=${RELAY_ALLOWED_TARGETS:-https://opencode.ai,https://api.kilo.ai,https://oai.endpoints.kepler.ai.cloud.ovh.net}
      - RELAY_AUTH_TOKEN=${RELAY_AUTH_TOKEN:-}
      - LIVE_SIGNALS=${LIVE_SIGNALS:-0}
      - LIVE_SIGNAL_FILE=${LIVE_SIGNAL_FILE:-/signals/signals.json}
    volumes:
      - ./.keep-cold:/signals
    networks:
      default:
        ipv4_address: 10.244.0.100
    ports:
      - "${ROUTER_BIND}:${HOST_LO}-${HOST_HI}:${CONT_LO}-${CONT_HI}"
    depends_on:
ENTRY
fi

i=1
while [ "$i" -le "$COUNT" ]; do
echo "      - warp-${i}"
i=$((i + 1))
done

printf '\n'

if [ "$WITH_TUNNELS" = true ]; then
# No `depends_on: - relay` on tunnels by design: relay rebuilds must never
# cascade-restart these ephemeral tunnels (each restart mints new edge URLs
# and breaks every configured client line).
i=1
while [ "$i" -le "$COUNT" ]; do
PORT=$((BASE_PORT + i))
cat <<ENTRY
  tunnel-${i}:
    image: cloudflare/cloudflared:latest
    container_name: warp-relay-tunnel-${i}
    restart: always
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    command: tunnel --no-autoupdate --url http://10.244.0.100:${PORT}

ENTRY
i=$((i + 1))
done
fi

if [ "$USE_LITE" = true ] && [ "$NODE_ENGINE" = warp-lite ]; then
echo "volumes:"
i=1
while [ "$i" -le "$COUNT" ]; do
echo "  warp-data-${i}:"
i=$((i + 1))
done
fi
} > docker-compose.yml

echo "Generated docker-compose.yml with static IP 10.244.0.100 and ${COUNT} instances."
