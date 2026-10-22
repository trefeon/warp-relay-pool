#!/bin/sh
# warp-lite entrypoint - WireGuard-only Cloudflare WARP SOCKS5 proxy.
# Flow: auth guard -> skip-register check -> sanitize -> patch wg-quick ->
# capture routes -> wg up -> policy routes -> egress probe (background) -> exec microsocks.
# shellcheck shell=sh
set -eu

# ==========================================
# Defaults
# ==========================================
WG_CONF="${WG_CONF:-/etc/wireguard/wg0.conf}"
WG_DIR="$(dirname "$WG_CONF")"
WG_IFACE="${WG_IFACE:-wg0}"
WG_MTU="${MTU:-1280}"
LISTEN_ADDR="${BIND_ADDR:-0.0.0.0}"
LISTEN_PORT="${BIND_PORT:-1080}"
# Fail-safe opt-in required to start without SOCKS credentials.
ALLOW_NO_AUTH="${ALLOW_NO_AUTH:-0}"
ENABLE_IPV6="${ENABLE_IPV6:-1}"
TAILSCALE_CIDR="${TAILSCALE_CIDR:-100.64.0.0/10}"
TAILSCALE_CIDR_V6="${TAILSCALE_CIDR_V6:-fd7a:115c:a1e0::/48}"
KEEPALIVE="${KEEPALIVE:-15}"
ENDPOINT_IP="${ENDPOINT_IP:-}"
# Pinned release; set WGCF_VERSION=latest to resolve from the GitHub API.
WGCF_VERSION="${WGCF_VERSION:-2.3.1}"
WGCF_FALLBACK_VER="${WGCF_FALLBACK_VER:-2.3.1}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"
# Keep egress probe short so it never delays SOCKS readiness.
TRACE_TIMEOUT="${TRACE_TIMEOUT:-3}"
TRACE_CONNECT_TIMEOUT="${TRACE_CONNECT_TIMEOUT:-2}"

# ==========================================
# Logging helpers
# ==========================================
log()  { printf '%s\n' "==> [warp-lite] $*"; }
warn() { printf '%s\n' "==> [warp-lite] $*" >&2; }
die()  { printf '%s\n' "==> [warp-lite] $*" >&2; exit 1; }

# ==========================================
# Utility
# ==========================================
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Run a command with a hard wall-clock limit when possible.
# Usage: run_with_timeout SECONDS command [args...]
run_with_timeout() {
    secs="$1"
    shift
    if command_exists timeout; then
        timeout "$secs" "$@" 2>/dev/null && return 0
        return 1
    fi
    "$@"
}

github_auth_header() {
    token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    if [ -n "$token" ]; then
        printf 'Authorization: Bearer %s' "$token"
    fi
}

detect_arch() {
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)  printf 'amd64' ;;
        aarch64|arm64) printf 'arm64' ;;
        *) die "unsupported architecture: $arch (supported: x86_64/amd64, aarch64/arm64)" ;;
    esac
}

resolve_wgcf_version() {
    if [ "$WGCF_VERSION" != "latest" ]; then
        printf '%s' "$WGCF_VERSION"
        return 0
    fi
    fetch_latest_wgcf_version
}

fetch_latest_wgcf_version() {
    api="https://api.github.com/repos/ViRb3/wgcf/releases/latest"
    auth="$(github_auth_header)"
    body=""

    if [ -n "$auth" ]; then
        body="$(curl -fsSL -m "$CURL_TIMEOUT" -H "$auth" "$api" 2>/dev/null || true)"
    else
        body="$(curl -fsSL -m "$CURL_TIMEOUT" "$api" 2>/dev/null || true)"
    fi

    ver="$(printf '%s' "$body" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' | head -n 1)"
    if [ -z "$ver" ]; then
        warn "could not fetch latest wgcf version from GitHub API, using fallback v${WGCF_FALLBACK_VER}"
        printf '%s' "$WGCF_FALLBACK_VER"
        return 0
    fi
    printf '%s' "$ver"
}

download_file() {
    url="$1"
    dest="$2"
    tries=0
    max_tries=3

    while [ "$tries" -lt "$max_tries" ]; do
        tries=$((tries + 1))
        if curl -fsSL -m 30 -o "$dest" "$url" 2>/dev/null; then
            [ -s "$dest" ] && return 0
        fi
        warn "download failed (attempt ${tries}/${max_tries}): $url"
        sleep $((tries * 2))
    done
    return 1
}

# Extract first IPv4 CIDR from text.
extract_ipv4_cidr() {
    printf '%s' "$1" | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}' | head -n 1
}

# Extract first IPv6 CIDR (comma/space separated tokens with ':').
extract_ipv6_cidr() {
    printf '%s' "$1" \
        | tr ',' '\n' \
        | tr ' ' '\n' \
        | grep -E '^[0-9a-fA-F:]+/(6[4-9]|[7-9][0-9]|1[0-2][0-8])$' \
        | grep -E ':' \
        | head -n 1
}

is_truthy() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

# ==========================================
# Fail-safe guard: refuse to launch an unauthenticated public proxy
# unless ALLOW_NO_AUTH=1 explicitly opts in.
# Called first in main() so unsafe configs die before any
# registration or network activity.
# ==========================================
check_socks_auth_policy() {
    auth_user="${SOCKS_USER:-}"
    auth_pass="${SOCKS_PASS:-}"

    # Both credentials set: normal authenticated mode.
    if [ -n "$auth_user" ] && [ -n "$auth_pass" ]; then
        return 0
    fi

    # Half-configured credentials are always a misconfiguration.
    if [ -n "$auth_user" ] || [ -n "$auth_pass" ]; then
        die "SOCKS_USER and SOCKS_PASS must be set together; only one is set"
    fi

    # No credentials at all: require explicit opt-in.
    if ! is_truthy "$ALLOW_NO_AUTH"; then
        die "refusing to start unauthenticated proxy without SOCKS_USER/SOCKS_PASS; set ALLOW_NO_AUTH=1 to allow public mode explicitly"
    fi

    warn "ALLOW_NO_AUTH=1: starting in unauthenticated public mode"
    case "$LISTEN_ADDR" in
        0.0.0.0|::|'*')
            warn "SOCKS listening on ${LISTEN_ADDR}:${LISTEN_PORT}; keep host mapping on 127.0.0.1:1080:1080 unless authenticated"
            ;;
    esac
}

iface_has_global_ipv6() {
    dev="$1"
    ip -6 addr show dev "$dev" scope global 2>/dev/null | grep -q 'inet6 '
}

# ==========================================
# 1. Account registration / config bootstrap (wgcf)
# ==========================================
register_warp() {
    log "no config found, registering Cloudflare WARP (WireGuard)..."

    arch="$(detect_arch)"
    ver="$(resolve_wgcf_version)"
    log "wgcf version: v${ver} (${arch})"

    url="https://github.com/ViRb3/wgcf/releases/download/v${ver}/wgcf_${ver}_linux_${arch}"
    workdir="$(mktemp -d /tmp/warplite.XXXXXX)" || die "could not create temp dir"
    # shellcheck disable=SC2064
    trap 'rm -rf "$workdir"' EXIT INT TERM

    if ! download_file "$url" "$workdir/wgcf"; then
        die "wgcf download failed: $url"
    fi

    # Verify the release checksum before executing: the binary runs as root
    # with NET_ADMIN privileges in every relay.
    sums_url="https://github.com/ViRb3/wgcf/releases/download/v${ver}/checksums.txt"
    if ! download_file "$sums_url" "$workdir/checksums.txt"; then
        die "wgcf checksums download failed: $sums_url"
    fi
    expected="$(awk -v f="wgcf_${ver}_linux_${arch}" '$2 == f { print $1; exit }' "$workdir/checksums.txt")"
    actual="$(sha256sum "$workdir/wgcf" | awk '{ print $1 }')"
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        die "wgcf checksum mismatch (expected '${expected}', got '${actual}')"
    fi
    chmod +x "$workdir/wgcf"

    log "registering device with Cloudflare..."
    if ! (
        cd "$workdir"
        ./wgcf register --accept-tos >/dev/null 2>&1
        log "generating WireGuard profile..."
        ./wgcf generate >/dev/null 2>&1
    ); then
        die "wgcf register or generate failed"
    fi

    if [ ! -f "$workdir/wgcf-profile.conf" ]; then
        die "wgcf-profile.conf not found, registration likely failed"
    fi

    mv "$workdir/wgcf-profile.conf" "$WG_CONF"
    # Burn-after-read: drop account material and binary.
    rm -rf "$workdir"
    trap - EXIT INT TERM
    log "WARP profile generated"
}

# ==========================================
# 2. Sanitize and rebuild WireGuard profile
# ==========================================
sanitize_config() {
    [ -f "$WG_CONF" ] || die "config not found: $WG_CONF"

    # Snapshot raw Address lines before mutation.
    raw_address="$(grep -E '^[[:space:]]*Address[[:space:]]*=' "$WG_CONF" || true)"
    ipv4_addr="$(extract_ipv4_cidr "$raw_address")"
    ipv6_addr="$(extract_ipv6_cidr "$raw_address")"

    if [ -z "$ipv4_addr" ]; then
        ipv4_addr="$(extract_ipv4_cidr "$(cat "$WG_CONF")")"
    fi
    if [ -z "$ipv6_addr" ]; then
        ipv6_addr="$(extract_ipv6_cidr "$(cat "$WG_CONF")")"
    fi

    if [ -z "$ipv4_addr" ]; then
        die "could not parse IPv4 Address from config, profile may be corrupt"
    fi

    # Drop fields we will rewrite (BusyBox-safe patterns).
    sed -i \
        -e '/^[[:space:]]*Address[[:space:]]*=/d' \
        -e '/^[[:space:]]*AllowedIPs[[:space:]]*=/d' \
        -e '/^[[:space:]]*DNS[[:space:]]*=/d' \
        -e '/^[[:space:]]*[Mm][Tt][Uu][[:space:]]*=/d' \
        "$WG_CONF"

    # Build Address value (dual-stack when available).
    if is_truthy "$ENABLE_IPV6" && [ -n "$ipv6_addr" ]; then
        address_value="${ipv4_addr},${ipv6_addr}"
        log "dual-stack address: IPv4=${ipv4_addr} IPv6=${ipv6_addr}"
    else
        address_value="$ipv4_addr"
        if is_truthy "$ENABLE_IPV6" && [ -z "$ipv6_addr" ]; then
            warn "ENABLE_IPV6=1 but profile has no IPv6 address, IPv4-only"
        else
            log "IPv4 address: ${ipv4_addr}"
        fi
    fi

    if ! grep -q '^\[Interface\]' "$WG_CONF"; then
        die "config missing [Interface] section"
    fi
    sed -i "/^\[Interface\]/a Address = ${address_value}" "$WG_CONF"
    sed -i "/^\[Interface\]/a MTU = ${WG_MTU}" "$WG_CONF"
    log "MTU = ${WG_MTU}"

    # AllowedIPs under [Peer].
    if is_truthy "$ENABLE_IPV6" && [ -n "$ipv6_addr" ]; then
        allowed_ips="0.0.0.0/0, ::/0"
    else
        allowed_ips="0.0.0.0/0"
    fi

    if ! grep -q '^\[Peer\]' "$WG_CONF"; then
        die "config missing [Peer] section"
    fi
    sed -i "/^\[Peer\]/a AllowedIPs = ${allowed_ips}" "$WG_CONF"

    # PersistentKeepalive defeats NAT and idle drops.
    if grep -qi '^[[:space:]]*PersistentKeepalive[[:space:]]*=' "$WG_CONF"; then
        sed -i "s/^[[:space:]]*PersistentKeepalive[[:space:]]*=.*/PersistentKeepalive = ${KEEPALIVE}/g" "$WG_CONF"
    else
        sed -i "/^\[Peer\]/a PersistentKeepalive = ${KEEPALIVE}" "$WG_CONF"
    fi

    # Optional custom endpoint (IPv4 host:port or [IPv6]:port).
    if [ -n "${ENDPOINT_IP:-}" ]; then
        log "endpoint override: ${ENDPOINT_IP}"
        if grep -qi '^[[:space:]]*Endpoint[[:space:]]*=' "$WG_CONF"; then
            sed -i "s|^[[:space:]]*Endpoint[[:space:]]*=.*|Endpoint = ${ENDPOINT_IP}|g" "$WG_CONF"
        else
            sed -i "/^\[Peer\]/a Endpoint = ${ENDPOINT_IP}" "$WG_CONF"
        fi
    fi
}

# Alpine wg-quick may hard-fail on src_valid_mark; neutralize safely.
patch_wg_quick() {
    wg_quick_bin="$(command -v wg-quick || true)"
    if [ -n "$wg_quick_bin" ] && [ -f "$wg_quick_bin" ] && [ -w "$wg_quick_bin" ]; then
        # Pre-set the sysctl ourselves so semantics are preserved when possible.
        sysctl -w net.ipv4.conf.all.src_valid_mark=1 >/dev/null 2>&1 || true
        if is_truthy "$ENABLE_IPV6"; then
            sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null 2>&1 || true
            sysctl -w net.ipv6.conf.default.disable_ipv6=0 >/dev/null 2>&1 || true
            sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1 || true
            sysctl -w net.ipv6.conf.default.forwarding=1 >/dev/null 2>&1 || true
        fi
        # Remove the hard-failing line from wg-quick (idempotent).
        sed -i '/src_valid_mark/d' "$wg_quick_bin" 2>/dev/null || true
    fi
}

# ==========================================
# 3. Bring up interface and fix asymmetric routes
# ==========================================
capture_pre_warp_routes() {
    # Tailscale / CGNAT v4 path before the default route is hijacked.
    PRE_WARP_ROUTE_V4="$(ip -4 route get 100.64.0.1 2>/dev/null | head -n 1 || true)"
    PRE_WARP_GW_V4="$(printf '%s\n' "$PRE_WARP_ROUTE_V4" | awk '{for (i=1;i<=NF;i++) if ($i=="via") {print $(i+1); exit}}')"
    PRE_WARP_DEV_V4="$(printf '%s\n' "$PRE_WARP_ROUTE_V4" | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"

    PRE_WARP_GW_V6=""
    PRE_WARP_DEV_V6=""
    if is_truthy "$ENABLE_IPV6" && command_exists ip; then
        PRE_WARP_ROUTE_V6="$(ip -6 route get fd7a:115c:a1e0::1 2>/dev/null | head -n 1 || true)"
        PRE_WARP_GW_V6="$(printf '%s\n' "$PRE_WARP_ROUTE_V6" | awk '{for (i=1;i<=NF;i++) if ($i=="via") {print $(i+1); exit}}')"
        PRE_WARP_DEV_V6="$(printf '%s\n' "$PRE_WARP_ROUTE_V6" | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
    fi

    # Host/container primary path (for inbound reply policy routing).
    ORIG_GW_V4="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
    ORIG_DEV_V4="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
    ORIG_IP_V4=""
    if [ -n "${ORIG_DEV_V4:-}" ]; then
        ORIG_IP_V4="$(ip -4 addr show dev "$ORIG_DEV_V4" 2>/dev/null | awk '/inet / {print $2; exit}' | cut -d/ -f1)"
    fi

    ORIG_GW_V6=""
    ORIG_DEV_V6=""
    ORIG_IP_V6=""
    if is_truthy "$ENABLE_IPV6"; then
        ORIG_GW_V6="$(ip -6 route show default 2>/dev/null | awk '{print $3; exit}')"
        ORIG_DEV_V6="$(ip -6 route show default 2>/dev/null | awk '{print $5; exit}')"
        if [ -n "${ORIG_DEV_V6:-}" ]; then
            # Prefer global unicast, skip link-local fe80::.
            ORIG_IP_V6="$(ip -6 addr show dev "$ORIG_DEV_V6" scope global 2>/dev/null | awk '/inet6 / {print $2; exit}' | cut -d/ -f1)"
        fi
    fi
}

bring_up_wg() {
    log "bringing up kernel interface ${WG_IFACE}..."
    # Capture stderr; do not claim success when wg-quick fails.
    if ! wg_out="$(wg-quick up "$WG_IFACE" 2>&1)"; then
        printf '%s\n' "$wg_out" >&2
        warn "cleaning up half-initialized interface..."
        wg-quick down "$WG_IFACE" >/dev/null 2>&1 || true
        die "wg-quick up ${WG_IFACE} failed; check NET_ADMIN / kernel WireGuard module; try ENABLE_IPV6=0 if IPv6 is broken"
    fi
}

# Pin the WireGuard endpoint host route via the pre-WARP gateway so tunnel
# handshake/keepalive packets never loop into wg0 once the main-table
# default moves onto the tunnel. Resolves the configured Endpoint host
# (usually engage.cloudflareclient.com) and pins every result; folds in
# the live endpoint IP from `wg show` when it parses cleanly.
pin_wg_endpoint_route() {
    ep_line="$(grep -i '^[[:space:]]*Endpoint[[:space:]]*=' "$WG_CONF" 2>/dev/null | head -n 1 || true)"
    ep_hostport="$(printf '%s' "$ep_line" | cut -d= -f2- | tr -d '[:space:]')"
    if [ -z "$ep_hostport" ]; then
        warn "endpoint pin: no Endpoint in ${WG_CONF}, skipping"
        return 0
    fi
    case "$ep_hostport" in
        \[*\]*)
            ep_host="$(printf '%s' "$ep_hostport" | sed 's/^\[//; s/\].*//')"
            ;;
        *)
            ep_host="${ep_hostport%:*}"
            [ -n "$ep_host" ] || ep_host="$ep_hostport"
            ;;
    esac

    ep_ips="$(getent ahosts "$ep_host" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    if [ -z "$ep_ips" ]; then
        # Numeric literal fallback when DNS is unavailable.
        case "$ep_host" in
            *:*|*.*) ep_ips="$ep_host" ;;
        esac
    fi

    # Fold in the live endpoint IP actually in use when it parses cleanly
    # (bracketed v6 or dotted v4 with :port); ignore anything ambiguous.
    ep_live="$(wg show "$WG_IFACE" endpoints 2>/dev/null | awk '{print $2; exit}' || true)"
    live_ip=""
    case "$ep_live" in
        \[*\]:*) live_ip="$(printf '%s' "$ep_live" | sed 's/^\[//; s/\]:[0-9][0-9]*$//')" ;;
        *.*:*) live_ip="${ep_live%:*}"
            case "$live_ip" in
                *:*) live_ip="" ;;
            esac
            ;;
    esac
    case "$live_ip" in
        *:*|*.*) ep_ips="$(printf '%s\n%s\n' "$ep_ips" "$live_ip" | sort -u)" ;;
    esac

    if [ -z "$ep_ips" ]; then
        warn "endpoint pin: could not resolve ${ep_host}, skipping"
        return 0
    fi
    pinned=0
    for pin_ip in $ep_ips; do
    case "$pin_ip" in
            *:*)
                if [ -n "${ORIG_GW_V6:-}" ] && [ -n "${ORIG_DEV_V6:-}" ]; then
                    if ip -6 route replace "${pin_ip}/128" via "$ORIG_GW_V6" dev "$ORIG_DEV_V6" 2>/dev/null; then
                        pinned=$((pinned + 1))
                    else
                        warn "endpoint v6 pin failed for ${pin_ip}"
                    fi
                fi
                ;;
            *)
                if [ -n "${ORIG_GW_V4:-}" ] && [ -n "${ORIG_DEV_V4:-}" ]; then
                    if ip route replace "${pin_ip}/32" via "$ORIG_GW_V4" dev "$ORIG_DEV_V4" 2>/dev/null; then
                        pinned=$((pinned + 1))
                    else
                        warn "endpoint pin failed for ${pin_ip}"
                    fi
                fi
                ;;
        esac
    done
    if [ "$pinned" -gt 0 ]; then
        log "pinned WireGuard endpoint ${ep_host} via pre-WARP gateway (${pinned} route(s))"
    else
        warn "endpoint pin installed 0 routes for ${ep_host} (no v4/v6 pre-WARP gateway)"
    fi
}

install_policy_routes() {
    # IPv4: traffic sourced from the container IP must leave via the
    # original gateway (fixes published-port asymmetric blackhole).
    if [ -n "${ORIG_IP_V4:-}" ] && [ -n "${ORIG_GW_V4:-}" ] && [ -n "${ORIG_DEV_V4:-}" ]; then
        log "policy route IPv4 (from ${ORIG_IP_V4} via ${ORIG_GW_V4} dev ${ORIG_DEV_V4})"
        ip rule del from "$ORIG_IP_V4" table 128 2>/dev/null || true
        ip rule add from "$ORIG_IP_V4" table 128 priority 100 2>/dev/null || \
            warn "IPv4 ip rule add failed (kernel may lack multi-table support)"
        ip route replace table 128 default via "$ORIG_GW_V4" dev "$ORIG_DEV_V4" 2>/dev/null || \
            warn "IPv4 policy table 128 write failed"
    fi

    # IPv6 policy routing (table 129) for the container global address.
    if is_truthy "$ENABLE_IPV6" && [ -n "${ORIG_IP_V6:-}" ] && [ -n "${ORIG_GW_V6:-}" ] && [ -n "${ORIG_DEV_V6:-}" ]; then
        log "policy route IPv6 (from ${ORIG_IP_V6} via ${ORIG_GW_V6} dev ${ORIG_DEV_V6})"
        ip -6 rule del from "$ORIG_IP_V6" table 129 2>/dev/null || true
        ip -6 rule add from "$ORIG_IP_V6" table 129 priority 100 2>/dev/null || \
            warn "IPv6 ip rule add failed"
        ip -6 route replace table 129 default via "$ORIG_GW_V6" dev "$ORIG_DEV_V6" 2>/dev/null || \
            warn "IPv6 policy table 129 write failed"
    fi

    # Restore Tailscale (and similar) return paths so the mesh stays reachable.
    if [ -n "${PRE_WARP_GW_V4:-}" ] && [ -n "${PRE_WARP_DEV_V4:-}" ]; then
        if ip route replace "$TAILSCALE_CIDR" via "$PRE_WARP_GW_V4" dev "$PRE_WARP_DEV_V4" 2>/dev/null; then
            log "restored ${TAILSCALE_CIDR} return route via ${PRE_WARP_GW_V4} dev ${PRE_WARP_DEV_V4}"
        fi
    fi

    if is_truthy "$ENABLE_IPV6" && [ -n "${PRE_WARP_GW_V6:-}" ] && [ -n "${PRE_WARP_DEV_V6:-}" ]; then
        if ip -6 route replace "$TAILSCALE_CIDR_V6" via "$PRE_WARP_GW_V6" dev "$PRE_WARP_DEV_V6" 2>/dev/null; then
            log "restored ${TAILSCALE_CIDR_V6} return route via ${PRE_WARP_GW_V6} dev ${PRE_WARP_DEV_V6}"
        fi
    fi

    # --- Default-via-tunnel for Table=off seeds ---
    # Seeded profiles carry Table=off, so wg-quick installs zero routes and
    # the main table keeps `default via <container-gw>`: egress would leave
    # direct (warp=off). Steer egress through wg0 here. Exceptions stay in
    # the policy tables above (from-rules + mesh CIDRs), which is the
    # reference pattern with the Table=auto main-table hijack made explicit.
    # Pin the endpoint FIRST: handshake/keepalive must not loop into wg0.
    pin_wg_endpoint_route

    # Move the main-table default(s) onto the tunnel. Fail closed: without the
    # v4 default on wg0 the container keeps egressing from its host IP while
    # SOCKS stays up, and every upstream probe then looks healthy — the exact
    # silence mode this relay must never ship (the pilot-V1 route bug class).
    # restart: always re-runs the whole handshake path instead of serving.
    if ip route replace default dev "$WG_IFACE" 2>/dev/null; then
        log "main-table default now dev ${WG_IFACE} (tunnel egress)"
    else
        die "main-table default-via-tunnel install failed; refusing to serve SOCKS without tunnel egress"
    fi
    if is_truthy "$ENABLE_IPV6" && iface_has_global_ipv6 "$WG_IFACE"; then
        if ip -6 route replace ::/0 dev "$WG_IFACE" 2>/dev/null; then
            log "main-table v6 default now dev ${WG_IFACE}"
        else
            # A native v6 default would leak egress from the container address
            # while SOCKS reports success (microsocks resolves AAAA too).
            die "main-table v6 default-via-tunnel install failed; refusing to leak IPv6 egress"
        fi
    else
        # IPv6 is not tunneled: blackhole it so AAAA targets cannot leave via
        # the container's own address. More-specific mesh routes still win.
        if ip -6 route replace blackhole ::/0 2>/dev/null; then
            log "IPv6 egress blackholed (not tunneled)"
        else
            warn "could not install IPv6 blackhole route"
        fi
    fi

    # Tunnel-path proof for the pilot log (V1): must show dev wg0.
    log "route check: $(ip route get 1.1.1.1 2>/dev/null || echo 'ip route get failed')"
}

# Best-effort egress IP print. Must never block SOCKS startup for long.
# Prefer numeric Cloudflare endpoints to avoid DNS hangs on broken stacks.
show_egress_ip() {
    log "egress probe:"

    v4_ok=0
    # 1.1.1.1 is numeric, no DNS required.
    if out="$(run_with_timeout "$((TRACE_TIMEOUT + 1))" \
        curl -4 -sS --connect-timeout "$TRACE_CONNECT_TIMEOUT" -m "$TRACE_TIMEOUT" \
        https://1.1.1.1/cdn-cgi/trace 2>/dev/null || true)"; then
        ip_line="$(printf '%s\n' "$out" | grep '^ip=' || true)"
        if [ -n "$ip_line" ]; then
            warp_line="$(printf '%s\n' "$out" | grep '^warp=' || true)"
            log "  IPv4 ${ip_line}${warp_line:+ }${warp_line}"
            v4_ok=1
        fi
    fi
    if [ "$v4_ok" -eq 0 ]; then
        if out="$(run_with_timeout "$((TRACE_TIMEOUT + 1))" \
            curl -4 -sS --connect-timeout "$TRACE_CONNECT_TIMEOUT" -m "$TRACE_TIMEOUT" \
            https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)"; then
            ip_line="$(printf '%s\n' "$out" | grep '^ip=' || true)"
            if [ -n "$ip_line" ]; then
                warp_line="$(printf '%s\n' "$out" | grep '^warp=' || true)"
                log "  IPv4 ${ip_line}${warp_line:+ }${warp_line}"
                v4_ok=1
            fi
        fi
    fi
    if [ "$v4_ok" -eq 0 ]; then
        warn "IPv4 egress probe timed out (handshake slow or endpoint blocked)"
    fi

    if is_truthy "$ENABLE_IPV6"; then
        if ! iface_has_global_ipv6 "$WG_IFACE"; then
            warn "IPv6: ${WG_IFACE} has no global address, skipping probe"
            return 0
        fi
        v6_ok=0
        if out="$(run_with_timeout "$((TRACE_TIMEOUT + 1))" \
            curl -6 -sS --connect-timeout "$TRACE_CONNECT_TIMEOUT" -m "$TRACE_TIMEOUT" \
            https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)"; then
            ip_line="$(printf '%s\n' "$out" | grep '^ip=' || true)"
            if [ -n "$ip_line" ]; then
                warp_line="$(printf '%s\n' "$out" | grep '^warp=' || true)"
                log "  IPv6 ${ip_line}${warp_line:+ }${warp_line}"
                v6_ok=1
            fi
        fi
        if [ "$v6_ok" -eq 0 ]; then
            warn "IPv6 egress probe failed (tunnel not ready or target unreachable, SOCKS still usable)"
        fi
    fi
}

# ==========================================
# 4. Launch microsocks
# ==========================================
start_socks() {
    # Default 0.0.0.0 keeps legacy IPv4-only listen.
    # Set BIND_ADDR=:: for IPv6 (and typically dual-stack) listen.
    set -- microsocks -i "$LISTEN_ADDR" -p "$LISTEN_PORT"

    if [ -n "${SOCKS_USER:-}" ] && [ -n "${SOCKS_PASS:-}" ]; then
        log "SOCKS auth enabled (user: ${SOCKS_USER})"
        set -- "$@" -u "$SOCKS_USER" -P "$SOCKS_PASS"
    else
        warn "no-auth public mode (ALLOW_NO_AUTH=1); keep host mapping on 127.0.0.1"
    fi

    log "microsocks listening on ${LISTEN_ADDR}:${LISTEN_PORT}"
    exec "$@"
}

# ==========================================
# Main: single WireGuard path (no protocol dispatch)
# ==========================================
main() {
    # Fail-fast: block unsafe auth configs before any registration or network I/O.
    check_socks_auth_policy

    mkdir -p "$WG_DIR"

    if [ ! -f "$WG_CONF" ]; then
        register_warp
    else
        log "persisted config found, skipping registration"
    fi

    sanitize_config
    patch_wg_quick
    capture_pre_warp_routes
    bring_up_wg
    install_policy_routes

    # Never let the informational probe delay SOCKS listen.
    show_egress_ip &
    start_socks
}

main "$@"
