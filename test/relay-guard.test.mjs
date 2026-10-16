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
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

const CONNECTS = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BASE_PORT = 23000 + Math.floor(Math.random() * 2000);
const RELAY_PORT = BASE_PORT + 1;

let sink;
let child;

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
});

after(() => {
  child?.kill();
  sink?.close();
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
