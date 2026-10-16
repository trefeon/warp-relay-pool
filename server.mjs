import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProxyAgent } from "undici";

const COUNT = parseInt(process.env.RELAY_COUNT || "10", 10);
const BASE_PORT = parseInt(process.env.BASE_PORT || "3000", 10);
const HEADER_TARGET = "x-relay-target";
const HEADER_PATH = "x-relay-path";
const HEADER_HOST = "host";
const DEFAULT_ALLOWED_TARGETS = "https://opencode.ai,https://api.kilo.ai";
const ALLOWED_TARGETS = (process.env.RELAY_ALLOWED_TARGETS ?? DEFAULT_ALLOWED_TARGETS)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Log-and-continue on programming errors: one bad request must never take
// down all 10 listeners in this process. Logging keeps the failure visible
// (journald/docker logs) instead of crashing or swallowing it silently.
process.on("unhandledRejection", (err) => {
  console.error(`[relay] unhandledRejection: ${err?.stack ?? String(err)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[relay] uncaughtException: ${err?.stack ?? String(err)}`);
});

function createRelayInstance(index) {
  const port = BASE_PORT + index;
  const warpHost = process.env[`WARP_HOST_${index}`] || `warp-${index}`;
  const warpPort = process.env[`WARP_PORT_${index}`] || "1080";
  const proxyUrl = `socks5://${warpHost}:${warpPort}`;
  const dispatcher = new ProxyAgent({ uri: proxyUrl, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 90_000, headersTimeout: 60_000, bodyTimeout: 0, connections: 32 });

  const server = http.createServer(async (req, res) => {
    const target = req.headers[HEADER_TARGET]?.replace(/\/$/, "");
    const relayPath = req.headers[HEADER_PATH] || "/";

    // Direct health check: only when NO x-relay-target header is passed
    if (!target) {
      try {
        const trace = await fetch("https://cloudflare.com/cdn-cgi/trace", { dispatcher });
        const text = await trace.text();
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(`Relay #${index} OK (via ${proxyUrl})\n\n${text}`);
      } catch (err) {
        // Detail stays in the logs: the body used to reflect String(err).
        console.error(`[relay #${index}] health check failed: ${err?.stack ?? String(err)}`);
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        return res.end(`Relay #${index} health check failed\n`);
      }
    }

    if (!ALLOWED_TARGETS.includes(target)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Forbidden target" }));
    }

    // The allowlist check above only validates the raw header string; the
    // request URL is target + relayPath, and a crafted path can continue the
    // host label (".attacker.tld/x" -> opencode.ai.attacker.tld), swap the
    // port (":8443/x"), or inject userinfo ("@evil.tld/x"). Build the URL
    // once and require it to stay on the allowlisted origin with a rooted
    // path. Concat (not URL-relative resolution) preserves the legacy
    // target+path semantics for any allowlist entry carrying a base path.
    let upstreamUrl;
    let targetOrigin;
    try {
      targetOrigin = new URL(target).origin;
      upstreamUrl = new URL(target + relayPath);
    } catch {
      upstreamUrl = null;
    }
    if (!upstreamUrl || upstreamUrl.origin !== targetOrigin || !relayPath.startsWith("/")) {
      console.error(`[relay #${index}] rejected relay path: target=${target} path=${relayPath}`);
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid relay path" }));
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k !== HEADER_TARGET && k !== HEADER_PATH && k !== HEADER_HOST && v) {
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
    }

    // 5-min upstream cap + client-disconnect wiring: a client that goes away
    // must not leave its upstream fetch hanging (leaked sockets pile up under
    // agent retries). Note req 'close' also fires on normal POST body
    // completion (socket still alive), so only abort when the socket actually
    // died; res 'close' covers disconnect-while-waiting for all methods.
    const controller = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded && req.socket?.destroyed) controller.abort();
    };
    req.once("close", onClientClose);
    res.once("close", onClientClose);
    const upstreamTimeout = AbortSignal.timeout(300000);
    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
        duplex: "half",
        dispatcher,
        signal: AbortSignal.any([upstreamTimeout, controller.signal]),
      });

      // Forward only what the client needs: full header copies cost per-request
      // work and risk stale content-encoding/content-length (fetch decodes
      // gzip/deflate/br, so those upstream values lie about our body).
      const outHeaders = { "cache-control": "no-cache", "x-accel-buffering": "no" };
      const contentType = upstream.headers.get("content-type");
      if (contentType) outHeaders["content-type"] = contentType;
      res.writeHead(upstream.status, outHeaders);
      // Kickstart: Node buffers headers until the first body byte, so TTFB
      // would wait for the first token. Flush now — headers land at
      // upstream-headers time instead.
      res.flushHeaders();
      if (upstream.body) {
        // Zero-copy pipe with backpressure; for-await + res.write() costs a
        // microtask per chunk and buffers against a slow client.
        await pipeline(Readable.fromWeb(upstream.body), res);
      } else {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        // Body stays generic: String(err) reflected attacker-controlled URLs
        // and internal proxy names back to the caller.
        console.error(`[relay #${index}] upstream error: ${err?.stack ?? String(err)}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream request failed" }));
      } else {
        // Headers already on the wire (mid-stream failure) — just cut it.
        // Unconditional writeHead here crashed the process (ERR_HTTP_HEADERS_SENT).
        res.destroy();
      }
    } finally {
      req.removeListener("close", onClientClose);
      res.removeListener("close", onClientClose);
    }
  });

  // TTFT tuning: Nagle off (first small frame goes immediately), long
  // keep-alive so cloudflared reuses the relay-app connection.
  server.keepAliveTimeout = 90_000;
  server.headersTimeout = 95_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on("connection", (socket) => socket.setNoDelay(true));

  server.listen(port, "0.0.0.0", () => {
    console.log(`Relay #${index} listening on 0.0.0.0:${port} -> ${proxyUrl}`);
  });
}

for (let i = 1; i <= COUNT; i++) {
  createRelayInstance(i);
}
