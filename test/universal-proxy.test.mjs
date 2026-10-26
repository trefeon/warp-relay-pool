// Universal-proxy tests for the wildcard/token/CONNECT/absolute-form contract.
//
// Runs the real server.mjs against a mapping SOCKS5 forwarder that records
// every CONNECT target but always dials the local plain-HTTP upstream. The
// CONNECT log is the ground truth: a dispatched request records its
// requested host:port; a rejected one (400/401/403) records nothing.
//
// Covers the frozen contract: exact-origin hits stay usable without a token,
// wildcard dispatch gates on x-relay-auth (401 without, 200 with),
// "*.suffix" matches apex+subdomains, "re:" matches origins, CONNECT pipes
// raw TCP on 443/80 only (403 on other ports, 401 without token),
// absolute-form req.url derives target+path, origin-escape stays 400, and
// upstream redirects stay 502 (never followed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
// Disjoint from relay-guard.test.mjs (23000-24099) and keep-cold.test.mjs
// (25000-25999) so parallel test files never bind each other's ports.
const BASE = 27000 + Math.floor(Math.random() * 500);
const EXACT_BASE = BASE;
const WILD_BASE = BASE + 10;
const SUF_BASE = BASE + 20;
const RE_BASE = BASE + 30;
const EXACT_PORT = EXACT_BASE + 1;
const WILD_PORT = WILD_BASE + 1;
const SUF_PORT = SUF_BASE + 1;
const RE_PORT = RE_BASE + 1;
const TOKEN = "test-token-123";

const CONNECTS = [];
let upstream;
let secondUpstream;
let secondHits = 0;
let forwarder;
const relays = [];

function startUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// Mapping forwarder: records the requested host:port, then dials the local
// plain-HTTP upstream regardless of the request. Tests use http:// targets
// only, so no TLS handshake ever traverses the mapped socket.
function startMappingForwarder(upstreamPort) {
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
            } else if (atyp === 0x04) {
              if (buf.length < 22) return;
              host = "[v6]";
              port = buf.readUInt16BE(20);
              consumed = 22;
            } else {
              sock.destroy();
              return;
            }
            buf = buf.subarray(consumed);
            stage = 2;
            CONNECTS.push(`${host}:${port}`);
            sock.removeListener("data", onData);
            const target = net.connect({ host: "127.0.0.1", port: upstreamPort });
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

function spawnRelay(basePort, allowlist, token) {
  const env = {
    ...process.env,
    RELAY_COUNT: "1",
    BASE_PORT: String(basePort),
    WARP_HOST_1: "127.0.0.1",
    WARP_PORT_1: String(forwarder.address().port),
    RELAY_ALLOWED_TARGETS: allowlist,
  };
  if (token) env.RELAY_AUTH_TOKEN = token;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay ${basePort} did not start`)), 15_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) {
        clearTimeout(timer);
        relays.push(child);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay ${basePort} exited early: ${code}`));
    });
  });
}

async function get(relayPort, { target, relayPath = "/v1/models", auth } = {}) {
  const headers = {};
  if (target !== undefined) headers["x-relay-target"] = target;
  if (relayPath !== undefined) headers["x-relay-path"] = relayPath;
  if (auth !== undefined) headers["x-relay-auth"] = auth;
  return fetch(`http://127.0.0.1:${relayPort}/v1/models`, { headers });
}

// Absolute-form: no x-relay-target; the request line itself carries the URI.
function getAbsolute(relayPort, absoluteUrl, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(absoluteUrl);
    const headers = { Host: `127.0.0.1:${relayPort}` };
    if (auth !== undefined) headers["x-relay-auth"] = auth;
    const req = http.request(
      { host: "127.0.0.1", port: relayPort, path: absoluteUrl, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Raw CONNECT: returns the status code plus the open socket for 200-pipe tests.
function connectRaw(relayPort, authority, { auth } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: relayPort });
    let lines = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (auth !== undefined) lines += `x-relay-auth: ${auth}\r\n`;
    lines += "\r\n";
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.subarray(0, idx).toString();
      const rest = buf.subarray(idx + 4);
      const status = Number(head.split("\r\n")[0].split(" ")[1]);
      sock.removeListener("data", onData);
      resolve({ status, socket: sock, rest });
    };
    sock.on("error", reject);
    sock.on("data", onData);
    sock.write(lines);
  });
}

function readSocket(sock, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(buf.toString());
    }, timeoutMs);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(buf.toString());
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(buf.toString());
    });
  });
}

before(async () => {
  upstream = await startUpstream((req, res) => {
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { location: `http://127.0.0.1:${secondUpstream.address().port}/secret` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
  secondUpstream = await startUpstream((_req, res) => {
    secondHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("second-upstream");
  });
  forwarder = await startMappingForwarder(upstream.address().port);
  const exactTarget = `http://127.0.0.1:${upstream.address().port}`;
  await spawnRelay(EXACT_BASE, exactTarget, TOKEN);
  await spawnRelay(WILD_BASE, "*", TOKEN);
  await spawnRelay(SUF_BASE, "*.example.com", "");
  await spawnRelay(RE_BASE, "re:^http://.*\\.example\\.com$", "");
});

after(() => {
  for (const r of relays) r?.kill();
  forwarder?.close();
  upstream?.close();
  secondUpstream?.close();
});

test("exact-origin hit stays usable without a token and strips auth headers", async () => {
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const res = await get(EXACT_PORT, { target });
  assert.equal(res.status, 200);
  const echo = JSON.parse(await res.text());
  assert.equal(echo.url, "/v1/models");
  assert.equal(echo.headers["x-relay-target"], undefined);
  assert.equal(echo.headers["x-relay-auth"], undefined);
});

test("exact allowlist still rejects non-allowlisted targets with 403", async () => {
  const res = await get(EXACT_PORT, { target: "https://evil.tld" });
  assert.equal(res.status, 403);
});

test("wildcard without a token is 401 and never dispatched", async () => {
  const before = CONNECTS.length;
  const res = await get(WILD_PORT, { target: `http://127.0.0.1:${upstream.address().port}` });
  assert.equal(res.status, 401);
  assert.equal(CONNECTS.length, before);
});

test("wildcard with a wrong token is 401", async () => {
  const res = await get(WILD_PORT, {
    target: `http://127.0.0.1:${upstream.address().port}`,
    auth: "wrong",
  });
  assert.equal(res.status, 401);
});

test("wildcard with a token dispatches and strips the auth header", async () => {
  const before = CONNECTS.length;
  const res = await get(WILD_PORT, {
    target: `http://127.0.0.1:${upstream.address().port}`,
    auth: TOKEN,
  });
  assert.equal(res.status, 200);
  const echo = JSON.parse(await res.text());
  assert.equal(echo.url, "/v1/models");
  assert.equal(echo.headers["x-relay-auth"], undefined);
  assert.ok(CONNECTS.length > before);
});

test("*.suffix matches the apex and subdomains", async () => {
  for (const h of ["http://example.com", "http://foo.example.com", "http://a.b.example.com"]) {
    const res = await get(SUF_PORT, { target: h });
    assert.equal(res.status, 200, `${h} must dispatch`);
    const echo = JSON.parse(await res.text());
    assert.equal(echo.url, "/v1/models");
  }
});

test("*.suffix rejects unrelated hosts with 403", async () => {
  const before = CONNECTS.length;
  const res = await get(SUF_PORT, { target: "http://other.com" });
  assert.equal(res.status, 403);
  assert.equal(CONNECTS.length, before);
});

test("re: entry dispatches matching origins and rejects the rest", async () => {
  const before = CONNECTS.length;
  const hit = await get(RE_PORT, { target: "http://foo.example.com" });
  assert.equal(hit.status, 200);
  assert.ok(CONNECTS.length > before);
  const miss = await get(RE_PORT, { target: "http://example.com" });
  assert.equal(miss.status, 403);
});

test("CONNECT pipes raw TCP on 443 with a token", async () => {
  const before = CONNECTS.length;
  const { status, socket, rest } = await connectRaw(WILD_PORT, "example.com:443", { auth: TOKEN });
  assert.equal(status, 200);
  assert.deepEqual(CONNECTS.slice(before), ["example.com:443"]);
  socket.write("GET /v1/models HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
  const initial = rest.length ? rest.toString() : "";
  const reply = initial + (await readSocket(socket));
  assert.match(reply, /HTTP\/1\.1 200/);
  assert.match(reply, /\/v1\/models/);
});

test("CONNECT to a disallowed port is 403 and never dispatched", async () => {
  const before = CONNECTS.length;
  const { status, socket } = await connectRaw(WILD_PORT, "example.com:8443", { auth: TOKEN });
  assert.equal(status, 403);
  socket.destroy();
  assert.equal(CONNECTS.length, before);
});

test("CONNECT without a token is 401 and never dispatched", async () => {
  const before = CONNECTS.length;
  const { status, socket } = await connectRaw(WILD_PORT, "example.com:443");
  assert.equal(status, 401);
  socket.destroy();
  assert.equal(CONNECTS.length, before);
});

test("CONNECT to a non-allowlisted host is 403", async () => {
  const before = CONNECTS.length;
  const { status, socket } = await connectRaw(SUF_PORT, "other.com:443");
  assert.equal(status, 403);
  socket.destroy();
  assert.equal(CONNECTS.length, before);
});

test("absolute-form req.url derives target+path without headers", async () => {
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const res = await getAbsolute(WILD_PORT, `${target}/v1/models`, { auth: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).url, "/v1/models");
});

test("absolute-form without a token is 401", async () => {
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const res = await getAbsolute(WILD_PORT, `${target}/v1/models`);
  assert.equal(res.status, 401);
});

test("health path stays exempt from the token gate", async () => {
  const res = await fetch(`http://127.0.0.1:${WILD_PORT}/v1/models`);
  // The mapping forwarder cannot complete the TLS trace fetch, so health
  // answers 500 here — the point is it is NOT 401.
  assert.equal(res.status, 500);
  assert.match(await res.text(), /health check failed/);
});

test("origin-escape paths stay 400 under wildcard+token", async () => {
  const target = `http://127.0.0.1:${upstream.address().port}`;
  for (const p of [".evil.tld/v1/models", "@evil.tld/v1/models", ":8443/v1/models", "https://evil.tld/x", "?x=1"]) {
    const before = CONNECTS.length;
    const res = await get(WILD_PORT, { target, relayPath: p, auth: TOKEN });
    assert.equal(res.status, 400, `path ${p} must be rejected`);
    assert.equal(CONNECTS.length, before, `path ${p} must not dispatch`);
  }
});

test("upstream redirects are not followed", async () => {
  const before = secondHits;
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const res = await get(WILD_PORT, { target, relayPath: "/redirect", auth: TOKEN });
  assert.equal(res.status, 502);
  assert.equal(secondHits, before);
});
