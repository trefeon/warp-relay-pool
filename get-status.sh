#!/bin/sh
# Print each relay's port, live egress IP, and tunnel URL (when tunnels
# exist), then the ready-to-paste client commands.
#
# Mesh direct ingress: host port 310N forwards to the relay app's container
# port 300N. The client lines use the router's actual host bind, parsed from
# the generated docker-compose.yml (the wizard sets INGRESS_BIND to the VPS
# Tailscale IP for mesh installs; the safe default bind is 127.0.0.1, which
# is not reachable from the tailnet and is reported as such). Quick-Tunnel
# `/freeflow add` lines print ONLY when tunnel containers exist (graceful
# when absent).
#
# Usage: ./get-status.sh [count]     (default COUNT env, else 10)
# Missing/stopped containers print "(starting...)" / "(not ready)" and
# never abort the table (safe under `set -e` callers too).
set -u

COUNT="${1:-${COUNT:-10}}"

case "$COUNT" in
  ''|*[!0-9]*)
    echo "error: count must be an integer 1..64, got '$COUNT'" >&2
    exit 1
    ;;
esac
if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 64 ]; then
  echo "error: count must be an integer 1..64, got '$COUNT'" >&2
  exit 1
fi

tunnel_url() {
  docker logs "warp-relay-tunnel-$1" 2>&1 \
    | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' \
    | tail -n 1 || true
}

egress_ip() {
  # 1. Fast host-side SOCKS5 probe (works for warp-lite and standard containers)
  socks_port=$((10800 + $1))
  ip="$(curl -s -m 4 -x "socks5h://127.0.0.1:${socks_port}" https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
  if [ -n "$ip" ]; then
    printf '%s' "$ip"
    return
  fi
  # 2. In-container docker exec fallback
  docker exec "warp-relay-warp-$1" curl -s -m 8 https://cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | sed -n 's/^ip=//p' || true
}

mesh_ip() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale ip -4 2>/dev/null | head -n 1 || true
  fi
}

echo "=== WARP relay status (1..${COUNT}) ==="
printf "%-10s %-8s %-34s %s\n" "INSTANCE" "PORT" "EGRESS IP" "TUNNEL URL"
echo "--------------------------------------------------------------------------------------------"

i=1
while [ "$i" -le "$COUNT" ]; do
  PORT=$((3000 + i))

  URL="$(tunnel_url "$i")"
  [ -z "$URL" ] && URL="(none / mesh-VPN direct)"

  # Egress address is a property of the WARP client container, so read it there
  # rather than through the relay app.
  IP="$(egress_ip "$i")"
  [ -z "$IP" ] && IP="(not ready)"

  printf "%-10s %-8s %-34s %s\n" "warp-${i}" ":${PORT}" "$IP" "$URL"
  i=$((i + 1))
done

TS_IP="$(mesh_ip)"
[ -z "$TS_IP" ] && TS_IP="<tailscale-ip>"

FOUND_TUNNELS=0
i=1
while [ "$i" -le "$COUNT" ]; do
  URL="$(tunnel_url "$i")"
  if [ -n "$URL" ]; then
    if [ "$FOUND_TUNNELS" -eq 0 ]; then
      echo ""
      echo "=== TryCloudflare Quick Tunnel commands (public HTTPS) ==="
    fi
    FOUND_TUNNELS=1
    echo "/freeflow add ${URL} relay-${i}"
  fi
  i=$((i + 1))
done

# Mesh client lines must reflect the router's actual host bind: the generated
# compose publishes "<bind>:3101-...", and loopback (the safe default) is not
# reachable from the tailnet. The wizard sets INGRESS_BIND to the Tailscale IP
# for mesh installs; tunnels-mode files carry no relay ports at all.
ROUTER_BIND="$(sed -n 's/^ *- "\([^":]*\):3101-.*$/\1/p' docker-compose.yml 2>/dev/null | head -n 1)"

if [ "$FOUND_TUNNELS" -eq 0 ]; then
  echo ""
  if [ -z "$ROUTER_BIND" ]; then
    echo "=== Mesh-VPN direct: relay router not host-published ==="
    echo "(generate a mesh-mode file: INGRESS_BIND=<tailscale-ip> ./generate-compose.sh ${COUNT})"
  elif [ "$ROUTER_BIND" = "127.0.0.1" ]; then
    echo "=== Mesh-VPN direct: router bound to 127.0.0.1 (not reachable from the tailnet) ==="
    echo "(re-run: INGRESS_BIND=${TS_IP} ./generate-compose.sh ${COUNT} && docker compose up -d)"
  else
    echo "=== Mesh-VPN direct commands (Tailscale private) ==="
    i=1
    while [ "$i" -le "$COUNT" ]; do
      TS_PORT=$((3100 + i))
      echo "/freeflow add http://${ROUTER_BIND}:${TS_PORT} relay-${i}"
      i=$((i + 1))
    done
  fi
else
  echo ""
  echo "=== Mesh-VPN direct: not published in tunnels mode ==="
  echo "(mesh ingress needs a mesh-mode deployment: ./generate-compose.sh ${COUNT})"
fi
