#!/bin/sh
# register-node.sh — provision the Cloudflare WARP device config for ONE MASQUE
# node (MicroWARP engine: usque, CONNECT-IP over HTTP/3 :443) and verify egress.
#
# Usage:
#   ./register-node.sh <N> [--bootstrap <socks-url>] [--force]
#   ./register-node.sh --print-registration <N>
#   ./register-node.sh --import-registration <N> <config.json>
#
# Bootstrap tiers (first that applies wins):
#   auto        a running pool node's in-network SOCKS port
#               (socks5://warp-relay-warp-<M>:1080) carries the registration
#               POST. Covers node N>=2 on a fresh host and every
#               re-registration.
#   explicit    --bootstrap <socks-url>, for a host-side or CI proxy.
#   zero-state  --print-registration / --import-registration. Node 1 of a fresh
#               host has no node to borrow, and api.cloudflareclient.com is
#               SNI-filtered on some paths: the registration POST runs on the
#               operator workstation (any docker host with a clean path to the
#               API) and the resulting usque config is imported back.
#
# Each node needs its own device config: state/warp-<N>/masque-config.json,
# bind-mounted read-only at /etc/wireguard/masque-config.json. That file holds
# a private key — it is gitignored and chmod 600. Cloudflare allows a limited
# number of devices per account, so --force overwrites a config but leaves the
# OLD device registered server-side.
set -eu

IMAGE="${MICROWARP_IMAGE:-ghcr.io/ccbkkb/microwarp:latest}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:latest}"
TRACE_URL="https://www.cloudflare.com/cdn-cgi/trace"

usage() {
  cat >&2 <<'USAGE'
usage: ./register-node.sh <N> [--bootstrap <socks-url>] [--force]
       ./register-node.sh --print-registration <N>
       ./register-node.sh --import-registration <N> <config.json>
USAGE
  exit 2
}

POOL_DIR="${POOL_DIR:-$(cd "$(dirname "$0")" && pwd)}"
NETWORK="${POOL_NETWORK:-$(basename "$POOL_DIR")_default}"

MODE=register
FORCE=0
BOOTSTRAP=""
POS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --print-registration) MODE=print; shift ;;
    --import-registration) MODE=import; shift ;;
    --bootstrap)
      [ $# -ge 2 ] || usage
      BOOTSTRAP="$2"
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage ;;
    --*) echo "error: unknown option '$1'" >&2; usage ;;
    *)
      POS="$POS $1"
      shift
      ;;
  esac
done

# shellcheck disable=SC2086 # positional slots are one integer and one file path
set -- $POS
N="${1:-}"
[ -n "$N" ] || usage
case "$N" in
  *[!0-9]*) echo "error: node index must be an integer, got '$N'" >&2; exit 2 ;;
esac
shift 2>/dev/null || true
IMPORT_FILE="${1:-}"
if [ "$MODE" = import ] && [ -z "$IMPORT_FILE" ]; then
  echo "error: --import-registration needs <config.json>" >&2
  exit 2
fi

DIR="$POOL_DIR/state/warp-$N"
CFG="$DIR/masque-config.json"
CONTAINER="warp-relay-warp-$N"
DEVICE="warp-relay-$N"

mkdir -p "$DIR"

refuse_overwrite() {
  [ -s "$CFG" ] || return 0
  [ "$FORCE" -eq 1 ] && return 0
  echo "warning: $CFG already exists and is non-empty." >&2
  echo "Refusing to overwrite a registered device on node $N." >&2
  echo "Use --force to overwrite. The old device stays registered on the" >&2
  echo "Cloudflare side and keeps counting against the device limit until" >&2
  echo "it is removed with 'usque account --delete' or in the dashboard." >&2
  exit 1
}

wait_healthy() {
  i=0
  st=missing
  while [ "$i" -lt 90 ]; do
    st="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
    [ "$st" = healthy ] && return 0
    sleep 2
    i=$((i + 2))
  done
  echo "error: $CONTAINER not healthy after ${i}s (status: $st)" >&2
  echo "see: docker logs $CONTAINER" >&2
  return 1
}

probe_egress() {
  docker run --rm --network "$NETWORK" "$CURL_IMAGE" -s --max-time 20 \
    -x "socks5h://$CONTAINER:1080" "$TRACE_URL" 2>/dev/null || true
}

activate() {
  echo "[2/4] recreating $CONTAINER"
  ( cd "$POOL_DIR" && docker compose up -d --force-recreate "warp-$N" )
  echo "[3/4] waiting for $CONTAINER health"
  wait_healthy
  echo "[4/4] probing egress through $CONTAINER:1080"
  trace="$(probe_egress)"
  case "$trace" in
    *warp=on*) printf '%s\n' "$trace" ;;
    *)
      echo "error: egress probe through $CONTAINER failed (no warp=on)" >&2
      printf '%s\n' "$trace" >&2
      exit 1
      ;;
  esac
  echo "done: node $N registered and verified"
}

# Tier 1/3: register from this host through a SOCKS5 bootstrap.
register_here() {
  bs=""
  if [ -n "$BOOTSTRAP" ]; then
    bs="$BOOTSTRAP"
  else
    nodes="$(docker ps --filter 'name=warp-relay-warp-' --format '{{.Names}}' 2>/dev/null \
      | sed -n 's/^warp-relay-warp-\([0-9][0-9]*\)$/\1/p' | sort -n)"
    for m in $nodes; do
      [ "$m" = "$N" ] && continue
      url="socks5://warp-relay-warp-$m:1080"
      out="$(docker run --rm --network "$NETWORK" "$CURL_IMAGE" -s --max-time 8 \
        -x "$url" "$TRACE_URL" 2>/dev/null || true)"
      case "$out" in
        *warp=on*) bs="$url"; break ;;
      esac
    done
  fi
  if [ -z "$bs" ]; then
    echo "error: no in-pool node to bootstrap through and no --bootstrap given." >&2
    echo "Node 1 of a fresh host needs the workstation tier:" >&2
    echo "  ./register-node.sh --print-registration $N" >&2
    echo "  ./register-node.sh --import-registration $N <config.json>" >&2
    exit 3
  fi
  echo "[1/4] registering device '$DEVICE' via usque (bootstrap: $bs)"
  docker run --rm --network "$NETWORK" \
    -e HTTPS_PROXY="$bs" \
    -v "$DIR:/out" \
    "$IMAGE" usque -c /out/masque-config.json register -a -n "$DEVICE"
  [ -s "$CFG" ] || { echo "error: registration wrote no $CFG" >&2; exit 1; }
  chmod 600 "$CFG"
  activate
}

# Tier 2a: print the registration command to run on the operator workstation.
print_registration() {
  echo "# Run this on the workstation that will perform the registration."
  echo "# It needs docker and a network where api.cloudflareclient.com resolves."
  echo "mkdir -p wrp-reg"
  echo "docker run --rm -v \"\$PWD/wrp-reg:/out\" $IMAGE \\"
  echo "  usque -c /out/masque-config.json register -a -n $DEVICE"
  echo
  echo "# Then bring the config back (cat wrp-reg/masque-config.json), save it"
  echo "# here as config.json, and run on the pool host:"
  echo "  ./register-node.sh --import-registration $N config.json"
}

# Tier 2b: validate and install a config produced elsewhere, then activate.
import_registration() {
  [ -f "$IMPORT_FILE" ] || { echo "error: $IMPORT_FILE not found" >&2; exit 1; }
  command -v node >/dev/null 2>&1 || {
    echo "error: node is required to validate the imported config" >&2
    exit 1
  }
  # shellcheck disable=SC2016 # the node program must reach node unexpanded
  node -e '
const fs = require("node:fs");
const [src, dst] = process.argv.slice(1);
const need = [
  "private_key", "id", "access_token", "ipv4", "ipv6",
  "endpoint_v4", "endpoint_v6", "endpoint_pub_key",
];
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(src, "utf8"));
} catch (err) {
  console.error(`error: ${src} is not JSON: ${err.message}`);
  process.exit(1);
}
const missing = need.filter((k) => !cfg[k]);
if (missing.length > 0) {
  console.error(`error: ${src} is not a usque config (missing: ${missing.join(", ")})`);
  console.error("expected the file written by `usque register` on the workstation");
  process.exit(1);
}
fs.writeFileSync(dst, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
console.log(`[1/4] imported device id=${cfg.id} interface=${cfg.ipv6}`);
' "$IMPORT_FILE" "$CFG"
  chmod 600 "$CFG"
  activate
}

case "$MODE" in
  print)
    refuse_overwrite
    print_registration
    ;;
  import)
    refuse_overwrite
    import_registration
    ;;
  *)
    refuse_overwrite
    register_here
    ;;
esac
