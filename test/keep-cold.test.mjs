// Behaviour tests for keep-cold's health accounting and env validation.
//
// No docker and no real upstream: fake relay listeners answer the probe wire
// shape directly, so a pass that decides not to rotate never touches docker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
// Disjoint from relay-guard.test.mjs (23000-23999): node --test runs the two
// files in parallel, so overlapping bands would intermittently collide.
const BASE_PORT = 25000 + Math.floor(Math.random() * 1000);
const relays = [];

function startRelay(port, throttledModel) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const throttled = throttledModel && body.includes(`"model":"${throttledModel}"`);
        if (throttled) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end('{"error":"rate limited"}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("");
      });
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function runKeepCold(env, args = ["--once"]) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["keep-cold.mjs", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RELAY_HOST: "127.0.0.1",
        BASE_PORT: String(BASE_PORT),
        PROBE_TIMEOUT_MS: "3000",
        TIER2_STATE_FILE: path.join(os.tmpdir(), `wrp-tier2-${process.pid}-${Math.random()}.json`),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  relays.push(await startRelay(BASE_PORT + 1, "model-a"));
  relays.push(await startRelay(BASE_PORT + 2, "model-a"));
});

after(() => {
  for (const srv of relays) srv.close();
});

test("--help prints usage and exits 0", async () => {
  const r = await runKeepCold({}, ["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--once/);
});

test("blank COUNT fails fast instead of probing nothing", async () => {
  const r = await runKeepCold({ COUNT: "" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /COUNT/);
});

test("blank PROBE_MODELS fails fast instead of a clean no-op", async () => {
  const r = await runKeepCold({ PROBE_MODELS: "" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PROBE_MODELS/);
});

test("log rotation caps must be ordered", async () => {
  const r = await runKeepCold({ KEEP_COLD_LOG_MAX_BYTES: "100", KEEP_COLD_LOG_KEEP_BYTES: "100" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /KEEP_COLD_LOG_KEEP_BYTES/);
});

test("a healthy pool reports clean N/N and exits 0", async () => {
  const r = await runKeepCold({
    COUNT: "2",
    PROBE_MODELS: "model-b,model-c",
    SPEED_MODEL: "model-b",
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /clean 2\/2 relay\(s\)/);
  assert.match(r.stdout, /pool is cold/);
});

test("relays throttled only on a quota-capped model are not counted clean", async () => {
  const r = await runKeepCold({
    COUNT: "2",
    PROBE_MODELS: "model-a,model-b",
    SPEED_MODEL: "model-b",
    GLOBAL_QUOTA_GUARD: "2",
  });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /clean 0\/2 relay\(s\)/);
  assert.match(r.stdout, /quota-capped: #1 #2/);
  assert.doesNotMatch(r.stdout, /pool is cold/);
});
