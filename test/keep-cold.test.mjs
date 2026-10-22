// Behaviour tests for keep-cold's demand-driven probing and rotation budget.
//
// No docker and no real upstream: fake relay listeners answer the probe wire
// shape directly (recording the model they were asked for), and a fake docker
// binary records every invocation, so restart decisions are asserted from the
// docker log instead of from a running pool. Each spawn gets its own state,
// signal and tier-2 files under a per-scenario temp dir; time is moved forward
// with KEEP_COLD_CLOCK_SKEW_S, so a multi-hour rotation budget is exercised in
// milliseconds of wall clock.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Node --test runs test files in parallel: relay-guard.test.mjs owns
// 23000-23999, this file takes fresh 64-port blocks from 25000-25999 and never
// reuses one.
const PORT_MIN = 25000;
const PORT_MAX = 25999;
const PORT_BLOCK = 64;
// Behaviour scenarios that bind relays: keep this in step with the tests below
// so the random start always leaves room for every block.
const SCENARIO_BLOCKS = 15;
let nextBlock = PORT_MIN
 + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1 - PORT_BLOCK * SCENARIO_BLOCKS));

const servers = [];
const tmpDirs = [];

function takeBlock() {
 const start = nextBlock;
 nextBlock += PORT_BLOCK;
 assert.ok(start + PORT_BLOCK - 1 <= PORT_MAX, `port band exhausted at ${start}`);
 return start;
}

function newScenario({ count, throttle = {} }) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrp-keep-cold-"));
 tmpDirs.push(dir);
 const fakeDocker = path.join(dir, "fake-docker.mjs");
 fs.writeFileSync(
  fakeDocker,
  'import fs from "node:fs";\nfs.appendFileSync(process.env.FAKE_DOCKER_LOG, process.argv.slice(2).join(" ") + "\\n");\n',
 );
 const throttles = new Map();
 for (let i = 1; i <= count; i++) throttles.set(i, new Map());
 for (const [relay, models] of Object.entries(throttle)) {
  for (const [model, spec] of Object.entries(models)) throttles.get(Number(relay)).set(model, spec);
 }
 return {
  dir,
  count,
  basePort: null,
  stateFile: path.join(dir, "state.json"),
  signalFile: path.join(dir, "signals.json"),
  tier2File: path.join(dir, "tier2.json"),
  dockerLog: path.join(dir, "docker.log"),
  fakeDocker,
  throttles,
 };
}

function startRelay(port, logFile, throttle) {
 return new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
   let body = "";
   req.on("data", (d) => (body += d));
   req.on("end", () => {
    let model = "";
    try {
     model = String(JSON.parse(body).model ?? "");
    } catch {
     model = "";
    }
    fs.appendFileSync(logFile, `${JSON.stringify({ model })}\n`);
    const spec = throttle.get(model);
    if (spec) {
     const headers = { "content-type": "application/json" };
     if (spec.retryAfter !== undefined) headers["retry-after"] = String(spec.retryAfter);
     res.writeHead(spec.status, headers);
     res.end('{"error":"rate limited"}');
     return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: {}\n\n");
   });
  });
  srv.once("error", reject);
  srv.listen(port, "127.0.0.1", () => resolve(srv));
 });
}

async function startRelays(sc, { dead = [] } = {}) {
 if (sc.basePort === null) sc.basePort = takeBlock();
 for (let i = 1; i <= sc.count; i++) {
  if (dead.includes(i)) continue;
  const srv = await startRelay(sc.basePort + i, path.join(sc.dir, `relay-${i}.log`), sc.throttles.get(i));
  servers.push(srv);
 }
}

function baseEnv(sc) {
 return {
  RELAY_HOST: "127.0.0.1",
  BASE_PORT: String(sc.basePort ?? 0),
  COUNT: String(sc.count),
  PROBE_MODELS: "model-a",
  PROBE_TIMEOUT_MS: "3000",
  PROBE_CONCURRENCY: "2",
  RELAY_STATE_FILE: sc.stateFile,
  LIVE_SIGNAL_FILE: sc.signalFile,
  TIER2_STATE_FILE: sc.tier2File,
  LIVE_SIGNALS: "0",
  KEEP_COLD_LOG: "",
  DOCKER_BIN: process.execPath,
  DOCKER_PREFIX_ARGS: sc.fakeDocker,
  FAKE_DOCKER_LOG: sc.dockerLog,
 };
}

function runOnce(sc, env = {}, args = ["--once"]) {
 return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["keep-cold.mjs", ...args], {
   cwd: REPO_ROOT,
   env: { ...process.env, ...baseEnv(sc), ...env },
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.once("error", reject);
  child.on("exit", (code) => {
   clearTimeout(timer);
   resolve({ code, stdout, stderr });
  });
 });
}

function requests(sc, index) {
 try {
  return fs.readFileSync(path.join(sc.dir, `relay-${index}.log`), "utf8").split("\n").filter(Boolean).length;
 } catch {
  return 0;
 }
}

function touchedRelays(sc) {
 const out = [];
 for (let i = 1; i <= sc.count; i++) if (requests(sc, i) > 0) out.push(i);
 return out;
}

function dockerLines(sc) {
 try {
  return fs.readFileSync(sc.dockerLog, "utf8").split("\n").filter(Boolean);
 } catch {
  return [];
 }
}

function restartLines(sc) {
 return dockerLines(sc).filter((line) => line.startsWith("restart "));
}

function entry(extra = {}) {
 return {
  lastProbe: 0,
  lastClean: 0,
  lastRotate: 0,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  probeAfter: 0,
  dirty: false,
  pendingVerify: false,
  last429: { model: "", ts: 0 },
  rotations: [],
  ...extra,
 };
}

function writeStateFile(sc, relays, auditCursor = 0) {
 fs.writeFileSync(sc.stateFile, JSON.stringify({ version: 1, auditCursor, relays }));
}

function seedCleanState(sc, auditCursor = 0) {
 const relays = {};
 for (let i = 1; i <= sc.count; i++) relays[String(i)] = entry({ lastProbe: Date.now(), lastClean: Date.now() });
 writeStateFile(sc, relays, auditCursor);
}

function readState(sc) {
 return JSON.parse(fs.readFileSync(sc.stateFile, "utf8"));
}

function stdoutLines(r) {
 return r.stdout.split("\n").filter(Boolean);
}

after(() => {
 for (const srv of servers) srv.close();
 for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── env validation ──────────────────────────────────────────────────
test("--help prints usage and exits 0", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, {}, ["--help"]);
 assert.equal(r.code, 0);
 assert.match(r.stdout, /--once/);
});

test("blank COUNT fails fast instead of probing nothing", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, { COUNT: "" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /COUNT/);
});

test("blank PROBE_MODELS fails fast instead of a clean no-op", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, { PROBE_MODELS: "" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /PROBE_MODELS/);
});

test("log rotation caps must be ordered", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, { KEEP_COLD_LOG_MAX_BYTES: "100", KEEP_COLD_LOG_KEEP_BYTES: "100" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /KEEP_COLD_LOG_KEEP_BYTES/);
});

test("blank RELAY_STATE_FILE is rejected", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, { RELAY_STATE_FILE: "" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /RELAY_STATE_FILE/);
});

test("backoff base below one second is rejected", async () => {
 const sc = newScenario({ count: 1 });
 const r = await runOnce(sc, { RELAY_BACKOFF_BASE_S: "0" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /RELAY_BACKOFF_BASE_S/);
});

test("audit sample cannot exceed COUNT", async () => {
 const sc = newScenario({ count: 2 });
 const r = await runOnce(sc, { PROBE_AUDIT_SAMPLE: "3" });
 assert.equal(r.code, 2);
 assert.match(r.stderr, /PROBE_AUDIT_SAMPLE/);
});

// ── case 1 + 10: a healthy pool costs the audit sample only ──────────
test("clean 20-relay pool with state probes only the audit sample", async () => {
 const sc = newScenario({ count: 20 });
 await startRelays(sc);
 seedCleanState(sc, 0);
 const r = await runOnce(sc, { PROBE_AUDIT_SAMPLE: "2" });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.deepEqual(touchedRelays(sc), [1, 2]);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /probing 2 of 20 relay\(s\) x 1 model\(s\)/);
 assert.match(r.stdout, /audit sample: #1 #2/);
 assert.match(r.stdout, /clean 20\/20 relay\(s\)/);
 assert.match(r.stdout, /pool is cold/);
 assert.ok(stdoutLines(r).length <= 10, `stdout had ${stdoutLines(r).length} lines:\n${r.stdout}`);
});

// ── case 2 + 3: one throttle, exactly one restart, then held ─────────
test("baseline sweep restarts only the throttled relay", async () => {
 const sc = newScenario({ count: 20, throttle: { 7: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const r = await runOnce(sc);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.match(r.stdout, /\(baseline\)/);
 assert.match(r.stdout, /probing 20 of 20 relay\(s\)/);
 assert.deepEqual(restartLines(sc), ["restart warp-relay-warp-7"]);
 assert.match(r.stdout, /clean 19\/20 relay\(s\)/);
 assert.match(r.stdout, /throttled: #7\(model-a\)/);
 assert.match(r.stdout, /pool is not cold: 1 relay\(s\) held or throttled/);

 const withinCooldown = await runOnce(sc, { KEEP_COLD_CLOCK_SKEW_S: "120" });
 assert.equal(withinCooldown.code, 1, withinCooldown.stdout);
 assert.equal(restartLines(sc).length, 1);
 assert.equal(requests(sc, 7), 1, "relay 7 must not be probed inside the settle window");

 const held = await runOnce(sc, { KEEP_COLD_CLOCK_SKEW_S: "240" });
 assert.equal(held.code, 1, held.stdout);
 assert.equal(restartLines(sc).length, 1);
 assert.match(held.stdout, /#7 held: cooldown \d+s remaining/);
 const remaining = Number(held.stdout.match(/#7 held: cooldown (\d+)s remaining/)[1]);
 assert.ok(remaining > 0 && remaining <= 360, `remaining cooldown ${remaining}s`);
});

// ── case 4: rolling-hour budget ─────────────────────────────────────
test("persistent throttle restarts at most twice in hour 1 and once in hour 2", async () => {
 const sc = newScenario({ count: 6, throttle: { 3: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const restartPasses = [];
 for (let pass = 0; pass < 24; pass++) {
  const before = restartLines(sc).length;
  const r = await runOnce(sc, { KEEP_COLD_CLOCK_SKEW_S: String(pass * 300) });
  const added = restartLines(sc).length - before;
  assert.ok(added <= 1, `pass ${pass} restarted ${added} relays:\n${r.stdout}`);
  for (let k = 0; k < added; k++) restartPasses.push(pass);
 }
 const hour1 = restartPasses.filter((p) => p < 12);
 const hour2 = restartPasses.filter((p) => p >= 12);
 assert.ok(hour1.length <= 2, `hour 1 restarts: ${hour1.join(",")}`);
 assert.ok(hour2.length <= 1, `hour 2 restarts: ${hour2.join(",")}`);
 assert.ok(restartPasses.length >= 2, `only ${restartPasses.length} restart(s) — the throttle was never rotated`);
});

// ── case 5: quota guard wins ───────────────────────────────────────
test("a model throttled on 9 of 20 relays is upstream quota, not egress", async () => {
 const throttle = {};
 for (let i = 1; i <= 9; i++) throttle[i] = { "model-a": { status: 429 } };
 const sc = newScenario({ count: 20, throttle });
 await startRelays(sc);
 const r = await runOnce(sc, { GLOBAL_QUOTA_GUARD: "9" });
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /model-a throttled on 9\/20 relays — upstream quota, skipping rotation for it this pass/);
 assert.match(r.stdout, /throttled only on quota-capped models \(left alone\): #1 #2 #3 #4 #5 #6 #7 #8 #9/);
 assert.match(r.stdout, /clean 11\/20 relay\(s\)/);
 assert.match(r.stdout, /quota-capped: #1 #2 #3 #4 #5 #6 #7 #8 #9/);
 assert.doesNotMatch(r.stdout, /pool is cold/);
});

// ── case 6: settle window ──────────────────────────────────────────
test("a relay inside the post-restart settle window is not probed", async () => {
 const sc = newScenario({ count: 20 });
 await startRelays(sc);
 const lastRotate = Date.now() - 10_000;
 writeStateFile(sc, {
  7: entry({
   dirty: true,
   pendingVerify: true,
   lastRotate,
   probeAfter: lastRotate + 150_000,
   rotations: [lastRotate],
   consecutiveFailures: 1,
  }),
 });
 const r = await runOnce(sc, { EGRESS_SETTLE_S: "150" });
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.equal(requests(sc, 7), 0, r.stdout);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /clean 19\/20 relay\(s\)/);
});

// ── case 6b: unreachable relay keeps the non-rotation path ─────────
test("an unreachable relay is troubled, never restarted", async () => {
 const sc = newScenario({ count: 2 });
 await startRelays(sc, { dead: [2] });
 const r = await runOnce(sc);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /#2 model-a unexpected HTTP unreachable — /);
 assert.match(r.stdout, /clean 1\/2 relay\(s\)/);
 const st = readState(sc).relays["2"];
 assert.equal(st.dirty, true);
 assert.ok(st.probeAfter > Date.now() + 590_000, `probeAfter ${st.probeAfter}`);
});

// ── case 7: Retry-After ────────────────────────────────────────────
test("retry-after 30 schedules the next probe instead of restarting", async () => {
 const sc = newScenario({ count: 2, throttle: { 1: { "model-a": { status: 429, retryAfter: 30 } } } });
 await startRelays(sc);
 const r = await runOnce(sc);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /#1 retry-after 30s — scheduling, no restart/);
 const delta = readState(sc).relays["1"].probeAfter - Date.now();
 assert.ok(delta > 25_000 && delta < 35_000, `probeAfter is now + ${delta}ms`);
});

// ── case 8: live signals ───────────────────────────────────────────
test("a live 429 signal rotates the named relay without probing it", async () => {
 const sc = newScenario({ count: 20 });
 await startRelays(sc);
 seedCleanState(sc, 1);
 fs.writeFileSync(sc.signalFile, JSON.stringify({
  signals: [{ ts: Math.floor(Date.now() / 1000), relay: 12, model: "model-a", status: 429, retryAfter: 30 }],
 }));
 const r = await runOnce(sc, { LIVE_SIGNALS: "1", PROBE_AUDIT_SAMPLE: "2" });
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), ["restart warp-relay-warp-12"]);
 assert.equal(requests(sc, 12), 0, "the signalled relay must not be probed");
 assert.deepEqual(JSON.parse(fs.readFileSync(sc.signalFile, "utf8")), { signals: [] });
 assert.match(r.stdout, /audit sample: #2 #3/);
 assert.match(r.stdout, /pool is not cold: 1 relay\(s\) held or throttled/);
});

test("a live recovery signal marks the relay clean without probing it", async () => {
 const sc = newScenario({ count: 6 });
 await startRelays(sc);
 writeStateFile(sc, {
  4: entry({ dirty: true, pendingVerify: true, lastRotate: Date.now() - 3600_000, consecutiveFailures: 3, last429: { model: "model-a", ts: Date.now() - 60_000 } }),
 }, 0);
 fs.writeFileSync(sc.signalFile, JSON.stringify({ signals: [{ ts: Math.floor(Date.now() / 1000), relay: 4, model: "model-a", status: 200 }] }));
 const r = await runOnce(sc, { LIVE_SIGNALS: "1", PROBE_AUDIT_SAMPLE: "2" });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.equal(requests(sc, 4), 0);
 assert.equal(readState(sc).relays["4"].dirty, false);
 assert.match(r.stdout, /pool is cold/);
});

// ── case 8b: signals never outvote the quota guard ─────────────────
test("live signals for a quota-capped model restart nothing", async () => {
 const sc = newScenario({ count: 20 });
 await startRelays(sc);
 seedCleanState(sc, 5);
 // Nine relays reporting the same model is the pool-wide quota signature:
 // rotating each of them would be the exact churn this scheduler removes.
 const signals = [];
 for (let i = 1; i <= 9; i++) {
  signals.push({ ts: Math.floor(Date.now() / 1000), relay: i, model: "model-a", status: 429, retryAfter: null });
 }
 fs.writeFileSync(sc.signalFile, JSON.stringify({ signals }));
 const r = await runOnce(sc, { LIVE_SIGNALS: "1", GLOBAL_QUOTA_GUARD: "9" });
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /model-a throttled on 9\/20 relays — upstream quota/);
 assert.match(r.stdout, /quota-capped: #1 #2 #3 #4 #5 #6 #7 #8 #9/);
});

// ── case 9: state file robustness ──────────────────────────────────
test("a corrupt state file degrades to a full sweep", async () => {
 const sc = newScenario({ count: 2 });
 await startRelays(sc);
 fs.writeFileSync(sc.stateFile, "{not json");
 const r = await runOnce(sc);
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.equal((r.stdout.match(/state file unusable/g) ?? []).length, 1, r.stdout);
 assert.equal(requests(sc, 1), 1);
 assert.equal(requests(sc, 2), 1);
});

test("an unwritable state path still completes the pass", async () => {
 const sc = newScenario({ count: 2 });
 await startRelays(sc);
 const blocker = path.join(sc.dir, "blocker");
 fs.writeFileSync(blocker, "not a directory");
 const r = await runOnce(sc, { RELAY_STATE_FILE: path.join(blocker, "state.json") });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.equal(requests(sc, 1), 1);
 assert.equal(requests(sc, 2), 1);
});

// ── case 10: exit code contract ────────────────────────────────────
test("--once exits 0 on a clean pool and 1 on a held one", async () => {
 const cold = newScenario({ count: 2 });
 await startRelays(cold);
 const ok = await runOnce(cold);
 assert.equal(ok.code, 0, ok.stdout + ok.stderr);
 assert.match(ok.stdout, /pool is cold/);

 const held = newScenario({ count: 2, throttle: { 2: { "model-a": { status: 429 } } } });
 await startRelays(held);
 const bad = await runOnce(held);
 assert.equal(bad.code, 1, bad.stdout + bad.stderr);
 assert.match(bad.stdout, /pool is not cold: 1 relay\(s\) held or throttled/);
});
