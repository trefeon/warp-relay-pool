# ==========================================
# Stage 1: Build microsocks (pure C SOCKS5)
# ==========================================
FROM alpine:3.21 AS microsocks-builder

RUN apk add --no-cache build-base git

ARG MICROSOCKS_REF=v1.0.5
RUN git clone --depth 1 --branch "${MICROSOCKS_REF}" \
    https://github.com/rofl0r/microsocks.git /src \
    && make -C /src

# ==========================================
# Stage 2: Minimal runtime (WireGuard only)
# ==========================================
FROM alpine:3.21

# wireguard-tools: wg-quick + wg
# iptables: both iptables and ip6tables on Alpine
# iproute2: ip rule/route for policy routing
# curl + ca-certificates: wgcf bootstrap + HTTPS trace probes
# openresolv: satisfies resolvconf calls from wg-quick code paths
RUN apk add --no-cache \
    wireguard-tools \
    iptables \
    iproute2 \
    curl \
    ca-certificates \
    openresolv \
    && update-ca-certificates \
    && rm -rf /var/cache/apk/*

COPY --from=microsocks-builder /src/microsocks /usr/local/bin/microsocks

WORKDIR /app
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh \
    && mkdir -p /etc/wireguard

EXPOSE 1080/tcp
# WireGuard profile persists here across restarts (tier-1/tier-2 rotation).
VOLUME ["/etc/wireguard"]

# microsocks is PID 1 and installs no SIGTERM handler, so PID 1 ignores it and
# every `docker restart` waits the full 10s grace before SIGKILL.
STOPSIGNAL SIGKILL

# A stale handshake is this image's dominant failure mode ("running" but
# blackholed). wg-quick refreshes latest-handshakes on every handshake.
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD sh -c 'now=$(date +%s); h=$(wg show wg0 latest-handshakes 2>/dev/null | head -n1 | cut -f2); [ -n "$h" ] && [ "$h" -gt 0 ] && [ $((now-h)) -lt 300 ]'

CMD ["./entrypoint.sh"]
