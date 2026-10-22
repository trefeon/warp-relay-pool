// Integration test for the relay's allowlist boundary.
//
// Runs the real server.mjs against a fake SOCKS5 sink that records every
// CONNECT target, then drives it with crafted x-relay-path values. The sink
// log is the ground truth: a request that reaches a non-allowlisted host
// shows up as a CONNECT to that host; a request rejected by the guard (400)
// must produce no CONNECT at all.
//
// Regression coverage for: host-label continuation (".evil.tld/x"),
// userinfo injection ("@evil.tld/x"), port swap (":8443/x"), absolute-URL
// paths, query-form paths — plus the boundary cases that must stay
// dispatchable ("/..." rooted paths keep the allowlisted host).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONNECTS = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
// Disjoint from keep-cold.test.mjs (25000-25999) so parallel test files cannot
// bind each other's relay port.
const BASE_PORT = 23000 + Math.floor(Math.random() * 1000);
const RELAY_PORT = BASE_PORT + 1;

let sink;
let child;

// ── Success-path harness ─────────────────────────────────────────────
// A real forwarding SOCKS5 server plus a local HTTP upstream proves the
// response/streaming half of the relay: without it every test above ends in
// the deliberate 502 and cannot see a dropped body, a leaked header, or a
// followed redirect.
let forwarder;
let upstream;
let secondUpstream;
let relay2;
let upstreamHits = 0;
let secondHits = 0;
// Live signal state files live outside the repo so a test run never dirties
// the tree (and .keep-cold/ is git-ignored anyway).
let signalDir;
let signalFile;

function startForwarder() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on("error", () => {});
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (stage === 0) {
            if (buf.length < 2) return;
            const nm = buf[1];
            if (buf.length < 2 + nm) return;
            buf = buf.subarray(2 + nm);
            sock.write(Buffer.from([0x05, 0x00]));
            stage = 1;
          } else if (stage === 1) {
            if (buf.length < 4) return;
            const atyp = buf[3];
            let host;
            let port;
            let consumed;
            if (atyp === 0x01) {
              if (buf.length < 10) return;
              host = Array.from(buf.subarray(4, 8)).join(".");
              port = buf.readUInt16BE(8);
              consumed = 10;
            } else if (atyp === 0x03) {
              if (buf.length < 5) return;
              const len = buf[4];
              if (buf.length < 7 + len) return;
              host = buf.subarray(5, 5 + len).toString();
              port = buf.readUInt16BE(5 + len);
              consumed = 7 + len;
            } else {
              sock.destroy();
              return;
            }
            buf = buf.subarray(consumed);
            stage = 2;
            sock.removeListener("data", onData);
            const target = net.connect({ host, port });
            target.once("connect", () => {
              sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              if (buf.length) target.write(buf);
              target.pipe(sock);
              sock.pipe(target);
            });
            target.once("error", () => sock.destroy());
            sock.once("error", () => target.destroy());
            return;
          } else {
            return;
          }
        }
      };
      sock.on("data", onData);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function startUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        upstreamHits++;
        handler(req, res, body);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function hitSecond(relayPath, opts = {}) {
  const headers = { "x-relay-target": opts.target ?? `http://127.0.0.1:${upstream.address().port}` };
  if (relayPath !== undefined) headers["x-relay-path"] = relayPath;
  return fetch(`http://127.0.0.1:${BASE_PORT2 + 1}${opts.urlPath ?? "/v1/models"}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  });
}

const BASE_PORT2 = BASE_PORT + 100;

function startSink() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on("error", () => {});
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (stage === 0) {
            if (buf.length < 2) return;
            const nm = buf[1];
            if (buf.length < 2 + nm) return;
            buf = buf.subarray(2 + nm);
            sock.write(Buffer.from([0x05, 0x00])); // no-auth
            stage = 1;
          } else if (stage === 1) {
            if (buf.length < 4) return;
            const atyp = buf[3];
            let host;
            let port;
            if (atyp === 0x01) {
              if (buf.length < 10) return;
              host = Array.from(buf.subarray(4, 8)).join(".");
              port = buf.readUInt16BE(8);
            } else if (atyp === 0x03) {
              if (buf.length < 5) return;
              const len = buf[4];
              if (buf.length < 7 + len) return;
              host = buf.subarray(5, 5 + len).toString();
              port = buf.readUInt16BE(5 + len);
            } else {
              sock.destroy();
              return;
            }
            CONNECTS.push(`${host}:${port}`);
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            stage = 2;
            // Fail the tunnel quickly: nothing here speaks TLS.
            setTimeout(() => sock.destroy(), 200);
            return;
          } else {
            return;
          }
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function hit(relayPath, { target = "https://opencode.ai" } = {}) {
  const headers = {};
  if (target) headers["x-relay-target"] = target;
  if (relayPath !== undefined) headers["x-relay-path"] = relayPath;
  return fetch(`http://127.0.0.1:${RELAY_PORT}/v1/models`, { headers });
}

before(async () => {
  sink = await startSink();
  const sinkPort = sink.address().port;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RELAY_COUNT: "1",
      BASE_PORT: String(BASE_PORT),
      WARP_HOST_1: "127.0.0.1",
      WARP_PORT_1: String(sinkPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not start")), 15_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited early: ${code}`));
    });
  });

  // Success-path stack: local upstream (echo) + a forwarding SOCKS server +
  // a second relay instance allowlisted to that upstream.
  upstream = await startUpstream((req, res, body) => {
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { location: `http://127.0.0.1:${secondUpstream.address().port}/secret` });
      res.end();
      return;
    }
    if (req.url.startsWith("/ratelimit")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end('{"error":"slow down"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
  secondUpstream = await startUpstream((_req, res) => {
    secondHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("second-upstream");
  });
  forwarder = await startForwarder();
  signalDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-signals-"));
  signalFile = path.join(signalDir, "signals.json");
  relay2 = spawn(process.execPath, ["server.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RELAY_COUNT: "1",
      BASE_PORT: String(BASE_PORT2),
      WARP_HOST_1: "127.0.0.1",
      WARP_PORT_1: String(forwarder.address().port),
      RELAY_ALLOWED_TARGETS: `http://127.0.0.1:${upstream.address().port}`,
      LIVE_SIGNALS: "1",
      LIVE_SIGNAL_FILE: signalFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second relay did not start")), 15_000);
    relay2.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    relay2.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`second relay exited early: ${code}`));
    });
  });
});

after(() => {
  child?.kill();
  relay2?.kill();
  sink?.close();
  forwarder?.close();
  upstream?.close();
  secondUpstream?.close();
  try {
    fs.rmSync(signalDir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the file briefly after the child exits.
  }
});

test("rooted path dispatches through the sink to the allowlisted host", async () => {
  const before = CONNECTS.length;
  const res = await hit("/v1/models");
  // The sink tears the TLS handshake down, so the relay reports 502 — the
  // CONNECT record is the assertion that matters.
  assert.equal(res.status, 502);
  assert.deepEqual(CONNECTS.slice(before), ["opencode.ai:443"]);
});

test("host-label continuation is rejected with 400 and never dispatched", async () => {
  const before = CONNECTS.length;
  const res = await hit(".evil.tld/v1/models");
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(await res.text()), { error: "Invalid relay path" });
  assert.equal(CONNECTS.length, before);
});

test("userinfo, port swap, absolute URL, and query forms are rejected", async () => {
  for (const p of [
    "@evil.tld/v1/models",
    ":8443/v1/models",
    "https://evil.tld/v1/models",
    "?x=1",
  ]) {
    const before = CONNECTS.length;
    const res = await hit(p);
    assert.equal(res.status, 400, `path ${p} must be rejected`);
    assert.equal(CONNECTS.length, before, `path ${p} must not dispatch`);
  }
});

test("protocol-relative path stays on the allowlisted host", async () => {
  const before = CONNECTS.length;
  const res = await hit("//evil.tld/v1/models");
  assert.equal(res.status, 502);
  assert.deepEqual(CONNECTS.slice(before), ["opencode.ai:443"]);
});

test("health check failure leaks no internals", async () => {
  const before = CONNECTS.length;
  const res = await hit(undefined, { target: "" });
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.match(body, /health check failed/);
  assert.doesNotMatch(body, /socks5|TypeError|127\.0\.0\.1|warp-/);
  assert.deepEqual(CONNECTS.slice(before), [`cloudflare.com:443`]);
});

test("non-allowlisted target still gets 403", async () => {
  const res = await hit("/v1/models", { target: "https://evil.tld" });
  assert.equal(res.status, 403);
});

// ── Success-path tests (local HTTP upstream, forwarding SOCKS) ───────
function rawRequest({ method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: BASE_PORT2 + 1, path: "/v1/models", method, headers },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("relayed request reaches the upstream and relay headers are stripped", async () => {
  const res = await hitSecond("/v1/models");
  assert.equal(res.status, 200);
  const echo = JSON.parse(await res.text());
  assert.equal(echo.method, "GET");
  assert.equal(echo.url, "/v1/models");
  assert.equal(echo.headers["x-relay-target"], undefined);
  assert.equal(echo.headers["x-relay-path"], undefined);
  assert.notEqual(echo.headers["accept-encoding"], "identity");
});

test("chunked upload is forwarded instead of 502", async () => {
  const res = await rawRequest({
    headers: {
      "x-relay-target": `http://127.0.0.1:${upstream.address().port}`,
      "x-relay-path": "/v1/models",
      "content-type": "application/json",
    },
    body: '{"stream":true}',
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).body, '{"stream":true}');
});

test("Expect: 100-continue upload is forwarded instead of 502", async () => {
  const res = await rawRequest({
    headers: {
      "x-relay-target": `http://127.0.0.1:${upstream.address().port}`,
      "x-relay-path": "/v1/models",
      "content-type": "application/json",
      expect: "100-continue",
    },
    body: '{"expect":true}',
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).body, '{"expect":true}');
});

test("upstream redirects are not followed", async () => {
  const before = secondHits;
  const res = await hitSecond("/redirect");
  assert.equal(res.status, 502);
  assert.equal(secondHits, before);
});

test("retry-after is forwarded to the client", async () => {
  const res = await hitSecond("/ratelimit");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
});

// ── Live 429 signals ────────────────────────────────────────────────
function readSignals() {
  try {
    const parsed = JSON.parse(fs.readFileSync(signalFile, "utf8"));
    return Array.isArray(parsed?.signals) ? parsed.signals : [];
  } catch {
    return [];
  }
}

// The writer coalesces on a timer, so a record appears up to flushMs later.
async function waitForSignals(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const signals = readSignals();
    if (predicate(signals) || Date.now() >= deadline) return signals;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a live 429 is signalled once per relay/model and cleared by recovery", async () => {
  const model = "test/model-a";
  const mine = (signals) => signals.filter((s) => s.model === model);

  const first = await hitSecond("/ratelimit", { method: "POST", body: JSON.stringify({ model }) });
  assert.equal(first.status, 429);
  await first.text();

  let signals = await waitForSignals((all) => mine(all).length === 1);
  assert.deepEqual(
    mine(signals).map(({ relay, model: m, status, retryAfter }) => ({ relay, model: m, status, retryAfter })),
    [{ relay: 1, model, status: 429, retryAfter: 7 }],
  );
  assert.equal(typeof mine(signals)[0].ts, "number");

  // A repeat 429 for the same key is not a state change: nothing is written
  // (the wait comfortably exceeds the writer's flush timer).
  const repeat = await hitSecond("/ratelimit", { method: "POST", body: JSON.stringify({ model }) });
  assert.equal(repeat.status, 429);
  await repeat.text();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(mine(readSignals()).length, 1);

  // A success for the same model is the recovery record.
  const ok = await hitSecond("/v1/models", { method: "POST", body: JSON.stringify({ model }) });
  assert.equal(ok.status, 200);
  await ok.text();

  signals = await waitForSignals((all) => mine(all).length === 2);
  const records = mine(signals);
  assert.equal(records.length, 2);
  assert.equal(records[1].status, 200);
  assert.equal(records[1].retryAfter, null);
  assert.equal(records[1].relay, 1);
});

test("keep-cold probe traffic is never signalled and its marker is stripped", async () => {
  // A probe's own 429 must not be replayed to the next pass as a "live" 429:
  // keep-cold marks its requests, the writer ignores them, and the marker never
  // reaches the upstream.
  const model = "test/probe-model";
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const throttled = await rawRequest({
    headers: {
      "x-relay-target": upstreamUrl,
      "x-relay-path": "/ratelimit",
      "x-keep-cold-probe": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model }),
  });
  assert.equal(throttled.status, 429);

  const clean = await rawRequest({
    headers: {
      "x-relay-target": upstreamUrl,
      "x-relay-path": "/v1/models",
      "x-keep-cold-probe": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model }),
  });
  assert.equal(clean.status, 200);
  assert.equal(JSON.parse(clean.body).headers["x-keep-cold-probe"], undefined);

  // Well past the writer's flush timer: no record may appear for this model.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(readSignals().filter((s) => s.model === model), []);
});
