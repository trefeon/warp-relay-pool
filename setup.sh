#!/bin/sh
# setup.sh — Automated installer and sizing wizard for warp-relay-pool.
# Uses MicroWARP (~1.8 MiB RAM/node) and TryCloudflare Quick Tunnels for instant setup.
set -eu

# Load .env when present (same loader as generate-compose.sh: process env
# wins, KEY=VALUE only, CRLF-safe, no value ever evaluated — EXCEPT that
# COUNT/RELAY_COUNT are excluded below: the wizard's VPS sizing owns the
# pool size, while the generator honors .env COUNT for manual runs). The
# wizard writes the final COUNT and BASE_PORT into the installed unit, so
# these values are the single source for the compose file AND the prober.
if [ -f .env ]; then
  cr="$(printf '\r')"
  dq='"' # quote characters, so the case patterns need no escapes
  sq="'"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%"$cr"}"
    case "$key" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
    # The wizard owns the pool size for wizard-driven installs (VPS sizing),
    # so a copied .env.example COUNT=10 does not silently out-vote the
    # recommended count on a small VPS; pin one with `COUNT=5 ./setup.sh`
    # (process env still wins above). BASE_PORT and the binds DO flow here:
    # generate-compose.sh bakes them and the unit must match.
    case "$key" in COUNT|RELAY_COUNT) continue ;; esac
    case "$val" in
      "$dq"*) val="${val#"$dq"}"; val="${val%%"$dq"*}" ;;
      "$sq"*) val="${val#"$sq"}"; val="${val%%"$sq"*}" ;;
      # Bare values follow compose's env-file behaviour: a whitespace-preceded
      # `#…` starts an inline comment and is stripped; quoted values end at
      # the closing quote with any trailing comment ignored.
      *) val="${val%%[[:space:]]#*}" ;;
    esac
    # shellcheck disable=SC2163,SC2086 # key is validated above
    eval "cur=\${$key:-}"
    [ -n "$cur" ] || export "$key=$val"
  done < .env
fi

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

log_info() { printf "${CYAN}==>${RESET} %s\n" "$*"; }
log_ok() { printf "${GREEN}==>${RESET} %s\n" "$*"; }
log_warn() { printf "${YELLOW}WARNING:${RESET} %s\n" "$*"; }
log_err() { printf "${RED}ERROR:${RESET} %s\n" "$*" >&2; }

# Helper to run commands as root if needed
run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    log_err "Root privileges required for: $*"
    exit 1
  fi
}

AUTO_YES=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) AUTO_YES=true ;;
    *) ;;
  esac
done

echo ""
echo "================================================================="
echo "   warp-relay-pool — Automated VPS Deployment Wizard"
echo "   MicroWARP Engine (WireGuard + microsocks, ~1.8 MiB / node)"
echo "================================================================="
echo ""

# -------------------------------------------------------------
# 1. OS and Environment Checks
# -------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo "Unknown")"
if [ "$OS" != "Linux" ]; then
  log_err "Cloudflare WARP requires Linux kernel features (NET_ADMIN / WireGuard)."
  log_err "Detected OS: $OS. Please deploy this on a Linux VPS or server."
  exit 1
fi

log_info "Checking and preparing prerequisites..."

# Auto-install curl if missing
if ! command -v curl >/dev/null 2>&1; then
  log_info "Installing curl..."
  if command -v apt-get >/dev/null 2>&1; then
    run_elevated apt-get update && run_elevated apt-get install -y curl
  elif command -v dnf >/dev/null 2>&1; then
    run_elevated dnf install -y curl
  elif command -v yum >/dev/null 2>&1; then
    run_elevated yum install -y curl
  elif command -v apk >/dev/null 2>&1; then
    run_elevated apk add curl
  fi
fi

# Auto-install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
  log_warn "Docker is not installed on this VPS."
  DO_INSTALL_DOCKER=true
  if [ "$AUTO_YES" != true ]; then
    printf "Would you like to automatically install Docker now? [Y/n]: "
    read -r ans || true
    case "$ans" in
      [nN]*) DO_INSTALL_DOCKER=false ;;
      *) DO_INSTALL_DOCKER=true ;;
    esac
  fi

  if [ "$DO_INSTALL_DOCKER" = true ]; then
    if ! command -v apt-get >/dev/null 2>&1 && ! command -v dnf >/dev/null 2>&1 && ! command -v yum >/dev/null 2>&1; then
      log_err "Automatic Docker installation is supported on Debian/Ubuntu/Fedora/CentOS only."
      log_err "Install Docker + the compose plugin with your package manager, then re-run."
      exit 1
    fi
    log_info "Installing Docker via official install script..."
    # Download first: a curl failure in a pipe is invisible to `sh` without
    # pipefail, which POSIX sh does not have.
    DOCKER_INSTALLER="$(mktemp)"
    if ! curl -fsSL https://get.docker.com -o "$DOCKER_INSTALLER"; then
      rm -f "$DOCKER_INSTALLER"
      log_err "Downloading https://get.docker.com failed."
      exit 1
    fi
    if ! run_elevated sh "$DOCKER_INSTALLER"; then
      rm -f "$DOCKER_INSTALLER"
      log_err "The Docker install script failed."
      exit 1
    fi
    rm -f "$DOCKER_INSTALLER"
    if [ "$(id -u)" -ne 0 ] && command -v usermod >/dev/null 2>&1; then
      if ! run_elevated usermod -aG docker "$USER"; then
        log_warn "Could not add ${USER} to the docker group; the wizard will continue under sudo."
      fi
    fi
    if command -v systemctl >/dev/null 2>&1; then
      run_elevated systemctl enable --now docker || true
    fi
    command -v docker >/dev/null 2>&1 || { log_err "Docker is still missing after installation."; exit 1; }
    log_ok "Docker installed successfully."
  else
    log_err "Docker is required to run the relay pool. Please install Docker and retry."
    exit 1
  fi
fi

# Check Docker Compose (plugin or standalone)
DOCKER_COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker-compose"
else
  log_info "Installing Docker Compose plugin..."
  if command -v apt-get >/dev/null 2>&1; then
    run_elevated apt-get update && run_elevated apt-get install -y docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    run_elevated dnf install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    run_elevated yum install -y docker-compose-plugin
  fi

  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  else
    log_err "Docker Compose plugin could not be auto-installed."
    echo "Please install it manually: sudo apt-get install -y docker-compose-plugin"
    exit 1
  fi
fi
# The daemon socket needs group membership that a fresh `usermod` does not
# apply to this shell. `docker compose version` is client-side and passes
# anyway, so check the daemon itself and re-exec under sudo when needed.
if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    log_info "Docker daemon not reachable as $(id -un); re-running the wizard under sudo..."
    exec sudo -E sh "$0" "$@"
  fi
  log_err "Cannot reach the Docker daemon."
  log_err "Re-login after 'usermod -aG docker $USER', or run this script with sudo."
  exit 1
fi
log_ok "Docker and Docker Compose verified ($DOCKER_COMPOSE)."

# Auto-install Node.js if missing (for keep-cold rotation prober)
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  log_warn "Node.js (>=18) is needed for the keep-cold auto-rotation prober."
  DO_INSTALL_NODE=true
  if [ "$AUTO_YES" != true ]; then
    printf "Install Node.js on the VPS for rate-limit auto-rotation? [Y/n]: "
    read -r ans || true
    case "$ans" in
      [nN]*) DO_INSTALL_NODE=false ;;
      *) DO_INSTALL_NODE=true ;;
    esac
  fi

  if [ "$DO_INSTALL_NODE" = true ]; then
    log_info "Installing Node.js..."
    if command -v apt-get >/dev/null 2>&1; then
      NODE_INSTALLER="$(mktemp)"
      if curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NODE_INSTALLER"; then
        run_elevated bash "$NODE_INSTALLER"
        rm -f "$NODE_INSTALLER"
        run_elevated apt-get install -y nodejs
      else
        rm -f "$NODE_INSTALLER"
        log_warn "Could not download the NodeSource setup script."
      fi
    elif command -v dnf >/dev/null 2>&1; then
      run_elevated dnf module install -y nodejs:22 || run_elevated dnf install -y nodejs
    elif command -v apk >/dev/null 2>&1; then
      run_elevated apk add nodejs
    fi
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -n "$NODE_BIN" ]; then
      log_ok "Node.js installed at $NODE_BIN ($("$NODE_BIN" -v))."
    fi
  fi
else
  log_ok "Node.js found at $NODE_BIN ($("$NODE_BIN" -v))."
fi

# -------------------------------------------------------------
# 2. Hardware Inspection & Dynamic Sizing
# -------------------------------------------------------------
TOTAL_RAM_MB=1024
AVAIL_RAM_MB=512
CPU_CORES=1

if [ -f /proc/meminfo ]; then
  TOTAL_RAM_KB="$(grep -i MemTotal /proc/meminfo | awk '{print $2}')"
  TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
  AVAIL_RAM_KB="$(grep -i MemAvailable /proc/meminfo | awk '{print $2}' || true)"
  if [ -n "$AVAIL_RAM_KB" ] && [ "$AVAIL_RAM_KB" -gt 0 ]; then
    AVAIL_RAM_MB=$((AVAIL_RAM_KB / 1024))
  else
    AVAIL_RAM_MB=$((TOTAL_RAM_MB / 2))
  fi
fi

if command -v nproc >/dev/null 2>&1; then
  CPU_CORES="$(nproc)"
fi

# Memory calculation:
# MicroWARP (~1.8 MiB) + TryCloudflare Tunnel (~20 MiB) = ~22 MiB per relay node.
# Relay router + prober base: ~50 MiB.
# Safe max = available RAM minus 80 MB OS cushion, divided by 22 MiB.
USABLE_RAM=$((AVAIL_RAM_MB - 80))
if [ "$USABLE_RAM" -lt 66 ]; then
  MAX_RELAYS=3
else
  MAX_RELAYS=$((USABLE_RAM / 22))
fi

# Cap at 64 max
if [ "$MAX_RELAYS" -gt 64 ]; then
  MAX_RELAYS=64
fi
if [ "$MAX_RELAYS" -lt 3 ]; then
  MAX_RELAYS=3
fi

# Recommended count: 5 relays is the sweet spot for most users!
# (5 independent egress IPs with auto rate-limit rotation provide huge throughput without wasting memory)
REC_COUNT=5
if [ "$REC_COUNT" -gt "$MAX_RELAYS" ]; then
  REC_COUNT=$MAX_RELAYS
fi

# Check Tailscale
TAILSCALE_DETECTED=false
TS_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [ -n "$TS_IP" ]; then
    TAILSCALE_DETECTED=true
  fi
fi

echo ""
echo "-----------------------------------------------------------------"
echo "  VPS Hardware Detected:"
echo "    • Total Memory:     ${TOTAL_RAM_MB} MB"
echo "    • Available Memory: ${AVAIL_RAM_MB} MB"
echo "    • CPU Cores:        ${CPU_CORES}"
echo ""
echo "  Relay Pool Sizing Guide (MicroWARP + TryCloudflare Tunnels):"
echo "    • Recommended:      ${REC_COUNT} relays (~160 MB total RAM)"
echo "      (5 relays + auto-rotation is ideal for heavy parallel coding agent turns)"
echo "    • Max Safe:         ${MAX_RELAYS} relays on this VPS (~$((MAX_RELAYS * 22 + 50)) MB RAM)"
echo "-----------------------------------------------------------------"
echo ""

# -------------------------------------------------------------
# 3. Interactive Relay Selection
# -------------------------------------------------------------
# Re-running the wizard on an existing host must not silently shrink the pool
# (Docker leaves the removed warp containers and their volumes running).
# Adopt the deployed shape unless COUNT/INGRESS are pinned explicitly.
DEPLOYED_COUNT="$(docker inspect warp-relay-app --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^RELAY_COUNT=\([0-9][0-9]*\)$/\1/p' | head -n 1 || true)"
DEPLOYED_INGRESS=""
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'warp-relay-tunnel-1'; then
  DEPLOYED_INGRESS="tunnels"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'warp-relay-app'; then
  DEPLOYED_INGRESS="tailscale"
fi
# The binds are part of the deployed shape too: a re-run must not silently
# re-publish a deliberately exposed WARP_BIND (or a custom router bind) as
# loopback. The compose file is the deployed truth; explicit env wins.
if [ -z "${WARP_BIND:-}" ] && [ -f docker-compose.yml ]; then
  WARP_BIND="$(sed -n 's/^ *- "\([^":]*\):[0-9][0-9]*:1080"$/\1/p' docker-compose.yml 2>/dev/null | head -n 1)"
  [ -n "$WARP_BIND" ] && export WARP_BIND
fi
if [ -z "${INGRESS_BIND:-}" ] && [ -f docker-compose.yml ]; then
  INGRESS_BIND="$(sed -n 's/^ *- "\([^":]*\):3101-.*$/\1/p' docker-compose.yml 2>/dev/null | head -n 1)"
  [ -n "$INGRESS_BIND" ] && export INGRESS_BIND
fi

COUNT_FROM_DEPLOY=0
if [ -z "${COUNT:-}" ] && [ -n "$DEPLOYED_COUNT" ]; then
  COUNT="$DEPLOYED_COUNT"
  COUNT_FROM_DEPLOY=1
else
  COUNT="${COUNT:-$REC_COUNT}"
fi
case "$COUNT" in
  ''|*[!0-9]*)
    log_warn "COUNT='${COUNT}' is not a number; using the recommended ${REC_COUNT}."
    COUNT="$REC_COUNT"
    ;;
esac
if [ "$COUNT" -gt "$MAX_RELAYS" ]; then
  if [ "$COUNT_FROM_DEPLOY" -eq 1 ]; then
    # The stack already runs this size; free RAM is low precisely because of
    # it. Shrinking here would orphan containers/volumes on a re-run.
    log_warn "Deployed count ${COUNT} is above the fresh-install recommendation (${MAX_RELAYS}); keeping it."
  else
    log_warn "COUNT=${COUNT} exceeds the safe maximum for this VPS (${MAX_RELAYS}); using ${MAX_RELAYS}."
    COUNT="$MAX_RELAYS"
  fi
fi
INGRESS_CHOICE="${INGRESS:-${DEPLOYED_INGRESS:-tunnels}}" # TryCloudflare is default for "just works" public access

PROMPT_MAX="$MAX_RELAYS"
if [ "$COUNT" -gt "$PROMPT_MAX" ]; then
  PROMPT_MAX="$COUNT"
fi

if [ "$AUTO_YES" = true ]; then
  log_info "Non-interactive mode (-y): using count = ${COUNT} relays."
  case "$INGRESS_CHOICE" in
    1|tailscale) log_info "Ingress method: Mesh-VPN direct (router bind resolved at generation)." ;;
    *) log_info "Ingress method: TryCloudflare Quick Tunnels (public HTTPS URLs)." ;;
  esac
else
  printf "How many relays do you want to create? [1-%s, default: %s]: " "$PROMPT_MAX" "$COUNT"
  read -r user_count || true
  if [ -n "$user_count" ]; then
    COUNT="$user_count"
    COUNT_FROM_DEPLOY=0
  fi

  echo ""
  echo "--- Choose Ingress Exposure ---"
  DEFAULT_INGRESS_NUM=1
  case "$INGRESS_CHOICE" in
    2|tailscale) DEFAULT_INGRESS_NUM=2 ;;
  esac
  if [ "$TAILSCALE_DETECTED" = true ]; then
    echo "  1) TryCloudflare Quick Tunnels (Recommended: public HTTPS, zero client VPN needed)"
    echo "  2) Tailscale Mesh-VPN Direct (Private static URL via ${TS_IP})"
    printf "Choose ingress method [1/2, default: %s]: " "$DEFAULT_INGRESS_NUM"
    read -r user_ingress || true
    if [ -n "$user_ingress" ]; then
      case "$user_ingress" in
        2) INGRESS_CHOICE="tailscale" ;;
        1) INGRESS_CHOICE="tunnels" ;;
      esac
    fi
  else
    echo "  1) TryCloudflare Quick Tunnels (Recommended: public HTTPS, zero client configuration)"
    echo "  2) Tailscale Mesh-VPN Direct (requires Tailscale on VPS + local machine)"
    printf "Choose ingress method [1/2, default: %s]: " "$DEFAULT_INGRESS_NUM"
    read -r user_ingress || true
    if [ -n "$user_ingress" ]; then
      case "$user_ingress" in
        2) INGRESS_CHOICE="tailscale" ;;
        1) INGRESS_CHOICE="tunnels" ;;
      esac
    fi
  fi
fi

# Interactive input can exceed the safe maximum (the clamp above only covers
# env/-y paths); re-validate the resolved count before anything uses it.
case "$COUNT" in
  ''|*[!0-9]*)
    log_warn "COUNT='${COUNT}' is not a number; using the recommended ${REC_COUNT}."
    COUNT="$REC_COUNT"
    ;;
esac
if [ "$COUNT" -gt "$MAX_RELAYS" ]; then
  if [ "$COUNT_FROM_DEPLOY" -eq 1 ]; then
    log_warn "Deployed count ${COUNT} is above the fresh-install recommendation (${MAX_RELAYS}); keeping it."
  else
    log_warn "COUNT=${COUNT} exceeds the safe maximum for this VPS (${MAX_RELAYS}); using ${MAX_RELAYS}."
    COUNT="$MAX_RELAYS"
  fi
fi
if [ "$COUNT" -lt 1 ]; then
  COUNT=1
fi

WITH_TUNNELS_FLAG=""
if [ "$INGRESS_CHOICE" = "tunnels" ] || [ "$INGRESS_CHOICE" = "1" ]; then
  WITH_TUNNELS_FLAG="--with-tunnels"
  log_info "Selected: TryCloudflare Quick Tunnels (${COUNT} relays)."
else
  log_info "Selected: Tailscale Mesh-VPN direct (${COUNT} relays)."
  if [ -n "$TS_IP" ]; then
    INGRESS_BIND="$TS_IP"
    export INGRESS_BIND
    log_info "Relay router will be published on ${TS_IP} only (Tailscale interface)."
  else
    log_warn "Tailscale IP not detected; relay router will stay on 127.0.0.1."
    log_warn "Authenticate Tailscale, then re-run: INGRESS_BIND=<tailscale-ip> sh ./generate-compose.sh ${COUNT}"
  fi
fi

# -------------------------------------------------------------
# 4. Build Minimal MicroWARP & Relay Images
# -------------------------------------------------------------
# The generated compose intentionally drops SYS_MODULE. Ensure the host loads
# the WireGuard module at boot so a reboot does not leave wg-quick unable to
# create its interface.
if command -v systemctl >/dev/null 2>&1 && { [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1; }; then
  if run_elevated sh -c 'mkdir -p /etc/modules-load.d && { grep -qx wireguard /etc/modules-load.d/wireguard.conf 2>/dev/null || echo wireguard > /etc/modules-load.d/wireguard.conf; }'; then
    log_info "WireGuard module will load at boot (/etc/modules-load.d/wireguard.conf)."
  else
    log_warn "Could not persist the WireGuard module load; verify 'modprobe wireguard' after reboot."
  fi
fi

log_info "Building minimal MicroWARP image (warp-lite:latest, ~1.8 MiB RAM/node)..."
docker build -t warp-lite:latest ./warp-lite

log_info "Generating docker-compose.yml for ${COUNT} relays..."
# shellcheck disable=SC2086
sh ./generate-compose.sh "$COUNT" $WITH_TUNNELS_FLAG

# Shared scheduler state: the relay app bind-mounts ./.keep-cold at /signals
# and writes signals.json as container root, while the host keep-cold prober
# (User=trefeon) writes state.json here. 0777 is deliberate and safe: the dir
# holds relay indexes, model names and timestamps only — no egress IPs, no
# secrets — and both writers replace files atomically (tmp + rename), so a
# root-owned signal file never blocks the host prober. The wizard may already
# be running as root (daemon re-exec), which is exactly why the mode is what
# grants access instead of ownership.
install -d -m 0777 .keep-cold

log_info "Starting containers with Docker Compose..."
$DOCKER_COMPOSE up -d --build --remove-orphans

# -------------------------------------------------------------
# 5. Wait for Readiness and Public URLs
# -------------------------------------------------------------
if [ -n "$WITH_TUNNELS_FLAG" ]; then
  log_info "Waiting for TryCloudflare Quick Tunnels to mint public URLs (approx 20-30s)..."
  attempt=0
  max_attempts=15
  tunnels_ready=false

  while [ "$attempt" -lt "$max_attempts" ]; do
    sleep 3
    attempt=$((attempt + 1))
    # Check if first tunnel URL is printed in docker logs
    first_url="$(docker logs warp-relay-tunnel-1 2>&1 | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | tail -n 1 || true)"
    if [ -n "$first_url" ]; then
      tunnels_ready=true
      break
    fi
    printf "."
  done
  echo ""
  if [ "$tunnels_ready" = true ]; then
    log_ok "Quick Tunnels established successfully!"
  else
    log_warn "Tunnels are still connecting in the background..."
  fi
else
  log_info "Waiting for WARP WireGuard handshakes..."
  sleep 15
fi

# -------------------------------------------------------------
# 6. Install Keep-Cold Auto-Rotation Service (Systemd)
# -------------------------------------------------------------
NODE_MAJOR=0
if [ -n "$NODE_BIN" ]; then
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [ -n "$NODE_BIN" ] && [ "$NODE_MAJOR" -lt 18 ]; then
  log_warn "Node.js $("$NODE_BIN" -v) is older than 18; the prober needs >=18. Skipping the timers."
fi

if [ -n "$NODE_BIN" ] && [ "$NODE_MAJOR" -ge 18 ] && command -v systemctl >/dev/null 2>&1; then
  SETUP_SYSTEMD=true
  if [ "$AUTO_YES" != true ]; then
    echo ""
    printf "Enable keep-cold + logwatch timers to auto-rotate rate-limited (429) relays? [Y/n]: "
    read -r ans || true
    case "$ans" in
      [nN]*) SETUP_SYSTEMD=false ;;
      *) SETUP_SYSTEMD=true ;;
    esac
  fi

  if [ "$SETUP_SYSTEMD" = true ]; then
    log_info "Configuring systemd keep-cold and logwatch services..."
    CURRENT_USER="$(id -un)"
    CURRENT_GROUP="$(id -gn)"
    CURRENT_DIR="$(pwd)"

    TMP_KEEP="$(mktemp)"
    sed -e "s|^User=.*|User=${CURRENT_USER}|" \
        -e "s|^Group=.*|Group=${CURRENT_GROUP}|" \
        -e "s|^WorkingDirectory=.*|WorkingDirectory=${CURRENT_DIR}|" \
        -e "s|^Documentation=.*|Documentation=file:${CURRENT_DIR}/keep-cold.mjs|" \
        -e "s|^Environment=KEEP_COLD_LOG=.*|Environment=KEEP_COLD_LOG=${CURRENT_DIR}/keep-cold.log|" \
        -e "s|^Environment=COUNT=.*|Environment=COUNT=${COUNT}|" \
        -e "s|^Environment=BASE_PORT=.*|Environment=BASE_PORT=${BASE_PORT:-3000}|" \
        -e "s|^ExecStart=.*|ExecStart=/usr/bin/flock -n -E 0 /tmp/warp-keep-cold.lock ${NODE_BIN} ${CURRENT_DIR}/keep-cold.mjs --once|" \
        systemd/warp-keep-cold.service > "$TMP_KEEP"

    TMP_WATCH="$(mktemp)"
    sed -e "s|^User=.*|User=${CURRENT_USER}|" \
        -e "s|^Group=.*|Group=${CURRENT_GROUP}|" \
        -e "s|^WorkingDirectory=.*|WorkingDirectory=${CURRENT_DIR}|" \
        -e "s|^Documentation=.*|Documentation=file:${CURRENT_DIR}/logwatch.sh|" \
        -e "s|^Environment=COUNT=.*|Environment=COUNT=${COUNT}|" \
        -e "s|^ExecStart=.*|ExecStart=/usr/bin/flock -n -E 0 /tmp/warp-logwatch.lock /bin/sh ${CURRENT_DIR}/logwatch.sh|" \
        systemd/warp-logwatch.service > "$TMP_WATCH"

    if run_elevated cp "$TMP_KEEP" /etc/systemd/system/warp-keep-cold.service \
       && run_elevated cp systemd/warp-keep-cold.timer /etc/systemd/system/warp-keep-cold.timer \
       && run_elevated cp "$TMP_WATCH" /etc/systemd/system/warp-logwatch.service \
       && run_elevated cp systemd/warp-logwatch.timer /etc/systemd/system/warp-logwatch.timer \
       && run_elevated systemctl daemon-reload \
       && run_elevated systemctl enable --now warp-keep-cold.timer warp-logwatch.timer; then
      log_ok "Keep-cold auto-rotation + logwatch active (5-minute timers)."
    else
      log_warn "systemd units were not installed; run 'node keep-cold.mjs --once' manually or re-run with sudo."
    fi
    rm -f "$TMP_KEEP" "$TMP_WATCH"
  fi
fi

# -------------------------------------------------------------
# 7. Final Output for pi-freeflow
# -------------------------------------------------------------
echo ""
sh ./get-status.sh "$COUNT"

echo ""
echo "======================================================================="
printf "${GREEN}${BOLD}✅ SETUP COMPLETE!${RESET}\n"
echo "======================================================================="
echo "📋 Copy the '/freeflow add' commands printed above and paste them"
echo "   directly into your OMP or Pi coding agent chat."
echo ""
echo "🚀 Next steps in your agent chat:"
echo "   /freeflow status   -> verify pool health"
echo "   /freeflow test     -> run an upstream inference test across all relays"
echo "   /freeflow spread   -> fan parallel subagents across all relays"
echo ""
echo "🔄 Rate-Limit Protection:"
echo "   If any relay encounters an upstream HTTP 429, keep-cold automatically"
echo "   rotates that container to a fresh egress IP. Your public tunnel URLs"
echo "   never change!"
echo "======================================================================="
echo ""
