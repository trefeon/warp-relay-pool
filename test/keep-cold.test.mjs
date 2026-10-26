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
const PORT_MAX = 26999;
const PORT_BLOCK = 32;
// Behaviour scenarios that bind relays: keep this in step with the tests below
// so the random start always leaves room for every block.
const SCENARIO_BLOCKS = 45;
let nextBlock = PORT_MIN
 + Math.floor(Math.random() * Math.max(1, PORT_MAX - PORT_MIN + 1 - PORT_BLOCK * SCENARIO_BLOCKS));

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
  `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, args.join(" ") + "\\n");

const restartStateFile = (process.env.FAKE_DOCKER_LOG || "") + ".restarts.json";
function getRestarts() {
  try { return JSON.parse(fs.readFileSync(restartStateFile, "utf8")); } catch { return {}; }
}
function recordRestart(c) {
  const s = getRestarts();
  s[c] = (s[c] || 0) + 1;
  fs.writeFileSync(restartStateFile, JSON.stringify(s));
}

if (args[0] === "restart") {
  recordRestart(args[1]);
} else if (args[0] === "exec") {
  const container = args[1];
  const subcmd = args[2];
  if (subcmd === "test" && args[3] === "-f" && args[4] === "/etc/wireguard/wg0.conf") {
    const missing = (process.env.FAKE_DOCKER_MISSING_WG0 || "").split(",").filter(Boolean);
    if (missing.includes(container)) {
      process.exit(1);
    }
    process.exit(0);
  } else if (subcmd === "curl") {
    const restarts = getRestarts()[container] || 0;
    const sticky = Number(process.env.FAKE_DOCKER_STICKY_RESTARTS || 0);
    const prefixSticky = Number(process.env.FAKE_DOCKER_PREFIX_STICKY || 0);
    const effective = restarts > sticky ? restarts : 0;
    const idx = container.replace(/^.*?-/, "");
    const stuckBlock = prefixSticky > 0 && restarts <= prefixSticky;
    let ip;
    if (effective === 0) ip = \`2a09:1:0::\${idx}\`;
    else if (stuckBlock) ip = \`2a09:1:0::\${effective}\${idx}\`;
    else ip = \`2a09:2:\${effective}:0::\${idx}\`;
    process.stdout.write(\`ip=\${ip}\\nwarp=on\\n\`);
    process.exit(0);
  }
}
`,
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
  blacklistFile: path.join(dir, "blacklist.json"),
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
    let tools = -1;
    let sys = "";
    try {
      const parsed = JSON.parse(body);
      model = String(parsed.model ?? "");
      tools = Array.isArray(parsed.tools) ? parsed.tools.length : -1;
      if (Array.isArray(parsed.messages)) {
        sys = parsed.messages.filter((m) => m && m.role === "system").map((m) => String(m.content ?? "")).join("\n");
      } else if (typeof parsed.instructions === "string") {
        sys = parsed.instructions;
      }
    } catch {
      model = "";
    }
    fs.appendFileSync(logFile, `${JSON.stringify({ model, ua: req.headers["user-agent"] ?? "", ocClient: req.headers["x-opencode-client"] ?? "", auth: req.headers["authorization"] ?? "", relayTarget: req.headers["x-relay-target"] ?? "", relayPath: req.headers["x-relay-path"] ?? "", keepCold: req.headers["x-keep-cold-probe"] ?? "", session: req.headers["x-opencode-session"] ?? "", tools, sys })}\n`);
    const rawSpec = throttle.get(model);
    const spec = typeof rawSpec === "function" ? rawSpec() : rawSpec;
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
  PREFIX_BLACKLIST_FILE: sc.blacklistFile,
  LIVE_SIGNALS: "0",
  KEEP_COLD_LOG: "",
  DOCKER_BIN: process.execPath,
  DOCKER_PREFIX_ARGS: sc.fakeDocker,
  FAKE_DOCKER_LOG: sc.dockerLog,
 };
}

function runOnce(sc, env = {}, args = ["--once"]) {
 return new Promise((resolve, reject) => {
  const combinedEnv = { ...process.env, ...baseEnv(sc), ...env };
  for (const [k, v] of Object.entries(env)) {
   if (v === undefined || v === null) delete combinedEnv[k];
  }
  const child = spawn(process.execPath, ["keep-cold.mjs", ...args], {
   cwd: REPO_ROOT,
   env: combinedEnv,
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

// ── case 4b: tier 2 waits for two failed verifications ──────────────
test("a re-rotation escalates to tier 2 only after two failed verifications", async () => {
 const sc = newScenario({ count: 2, throttle: { 1: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const rotatedAt = Date.now() - 700_000;
 writeStateFile(sc, {
  1: entry({
   lastRotate: rotatedAt,
   consecutiveFailures: 1,
   dirty: true,
   pendingVerify: true,
   last429: { model: "model-a", ts: rotatedAt },
   rotations: [rotatedAt],
  }),
 });
 const env = { EGRESS_SETTLE_S: "0", PROBE_AUDIT_SAMPLE: "0", RELAY_MAX_ROTATIONS_PER_HOUR: "4" };
 const first = await runOnce(sc, env);
 assert.equal(first.code, 1, first.stdout + first.stderr);
 // One prior failure: the second rotation is still the cheap tier-1 (a plain
 // restart, no Cloudflare registration).
 assert.match(fs.readFileSync(sc.dockerLog, "utf8"), /^restart warp-relay-warp-1$/m);
 assert.doesNotMatch(fs.readFileSync(sc.dockerLog, "utf8"), /rm -f \/etc\/wireguard\/wg0\.conf/);

 const second = await runOnce(sc, { ...env, KEEP_COLD_CLOCK_SKEW_S: "700" });
 assert.equal(second.code, 1, second.stdout + second.stderr);
 assert.match(fs.readFileSync(sc.dockerLog, "utf8"), /rm -f \/etc\/wireguard\/wg0\.conf/);
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
  signals: [{ ts: Date.now(), relay: 12, model: "model-a", status: 429, retryAfter: 30 }],
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
 fs.writeFileSync(sc.signalFile, JSON.stringify({ signals: [{ ts: Date.now(), relay: 4, model: "model-a", status: 200 }] }));
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
  signals.push({ ts: Date.now(), relay: i, model: "model-a", status: 429, retryAfter: null });
 }
 fs.writeFileSync(sc.signalFile, JSON.stringify({ signals }));
 const r = await runOnce(sc, { LIVE_SIGNALS: "1", GLOBAL_QUOTA_GUARD: "9" });
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.match(r.stdout, /model-a throttled on 9\/20 relays — upstream quota/);
 assert.match(r.stdout, /quota-capped: #1 #2 #3 #4 #5 #6 #7 #8 #9/);
});

// ── case 8c: a stale signal never re-rotates a restarted relay ──────
test("a signal older than the relay's last rotation is ignored", async () => {
 const sc = newScenario({ count: 4 });
 await startRelays(sc);
 const rotatedAt = Date.now() - 120_000;
 writeStateFile(sc, {
  2: entry({ lastRotate: rotatedAt, lastClean: Date.now() - 60_000 }),
 }, 0);
 fs.writeFileSync(sc.signalFile, JSON.stringify({
  signals: [{ ts: rotatedAt - 30_000, relay: 2, model: "model-a", status: 429, retryAfter: null }],
 }));
 const r = await runOnce(sc, { LIVE_SIGNALS: "1", PROBE_AUDIT_SAMPLE: "0" });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), []);
 assert.equal(requests(sc, 2), 0, "a stale signal must not probe the relay either");
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

// ── case 11: --fresh-ip-sweep contract ──────────────────────────────
test("--fresh-ip-sweep succeeds when at least one relay clears on the target model", async () => {
 const sc = newScenario({ count: 2, throttle: { 2: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0" }, ["--fresh-ip-sweep"]);
 assert.equal(r.code, 0, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.ok(lines.some((l) => l.startsWith("exec warp-relay-warp-1 rm -f /etc/wireguard/wg0.conf")), "warp-1 rm wg0.conf recorded");
 assert.ok(lines.some((l) => l.startsWith("restart warp-relay-warp-1")), "warp-1 restart recorded");
 assert.ok(lines.some((l) => l.startsWith("exec warp-relay-warp-2 rm -f /etc/wireguard/wg0.conf")), "warp-2 rm wg0.conf recorded");
 assert.ok(lines.some((l) => l.startsWith("restart warp-relay-warp-2")), "warp-2 restart recorded");
 assert.match(r.stdout, /fresh IP verified/i);
});

test("--fresh-ip-sweep identifies global upstream quota when all relays return 429", async () => {
 const sc = newScenario({
  count: 2,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0", GLOBAL_QUOTA_GUARD: "2" }, ["--fresh-ip-sweep"]);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const restarts = restartLines(sc);
 assert.equal(restarts.length, 2, "all relays rotated once");
 assert.match(r.stdout, /global.*upstream.*quota/i);
});

test("--fresh-ip-sweep aborts during preflight if a container lacks wg0.conf", async () => {
 const sc = newScenario({ count: 2 });
 await startRelays(sc);
 const r = await runOnce(sc, { FAKE_DOCKER_MISSING_WG0: "warp-relay-warp-2" }, ["--fresh-ip-sweep"]);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(restartLines(sc), [], "zero restarts performed on preflight failure");
 assert.match(r.stderr + r.stdout, /preflight|wg0\.conf/i);
});

test("--fresh-ip-sweep rejects mutual exclusion with --once or --loop", async () => {
 const sc = newScenario({ count: 1 });
 const rOnce = await runOnce(sc, {}, ["--fresh-ip-sweep", "--once"]);
 assert.equal(rOnce.code, 2);
 assert.match(rOnce.stderr, /mutually exclusive/i);

 const rLoop = await runOnce(sc, {}, ["--fresh-ip-sweep", "--loop"]);
 assert.equal(rLoop.code, 2);
 assert.match(rLoop.stderr, /mutually exclusive/i);
});

// ── case 12: --reset-until-clean contract ───────────────────────────
test("--reset-until-clean skips already clean relays and resets only rate-limited relays until clean", async () => {
 let r3Attempts = 0;
 let r4Attempts = 0;
 const sc = newScenario({
  count: 4,
  throttle: {
   3: {
    "model-a": () => {
     r3Attempts++;
     return r3Attempts <= 1 ? { status: 429 } : null;
    },
   },
   4: {
    "model-a": () => {
     r4Attempts++;
     return r4Attempts <= 2 ? { status: 429 } : null;
    },
   },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0" }, ["--reset-until-clean"]);
 assert.equal(r.code, 0, r.stdout + r.stderr);
 const restarts = restartLines(sc);
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-1")).length, 0, "warp-1 never reset");
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-2")).length, 0, "warp-2 never reset");
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-3")).length, 1, "warp-3 reset exactly once");
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-4")).length, 2, "warp-4 reset exactly twice");
 assert.match(r.stdout, /all.*clean|reset complete/i);
});

test("--reset-until-clean respects MAX_RESET_ATTEMPTS and exits 1 if relay remains throttled", async () => {
 const sc = newScenario({
  count: 2,
  throttle: {
   2: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "2" }, ["--reset-until-clean"]);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const restarts = restartLines(sc);
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-1")).length, 0, "warp-1 never reset");
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-2")).length, 2, "warp-2 reset exactly 2 times");
 assert.match(r.stdout + r.stderr, /exceeded|throttled|rate-limited/i);
});

test("--reset-until-clean never resets a relay failing for a non-rate-limit reason", async () => {
 const sc = newScenario({
  count: 3,
  throttle: {
   2: { "model-a": { status: 401 } },
   3: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "1" }, ["--reset-until-clean"]);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const restarts = restartLines(sc);
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-2")).length, 0, "a 401 is not an egress problem");
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-3")).length, 1, "the 429 relay is reset once");
 assert.match(r.stdout, /#2 not an egress rate limit/);
});

test("--reset-until-clean rejects mutual exclusion with --once, --loop, or --fresh-ip-sweep", async () => {
 const sc = newScenario({ count: 1 });
 const rOnce = await runOnce(sc, {}, ["--reset-until-clean", "--once"]);
 assert.equal(rOnce.code, 2);
 assert.match(rOnce.stderr, /mutually exclusive/i);

 const rLoop = await runOnce(sc, {}, ["--reset-until-clean", "--loop"]);
 assert.equal(rLoop.code, 2);
 assert.match(rLoop.stderr, /mutually exclusive/i);

 const rSweep = await runOnce(sc, {}, ["--reset-until-clean", "--fresh-ip-sweep"]);
 assert.equal(rSweep.code, 2);
 assert.match(rSweep.stderr, /mutually exclusive/i);
});

// ── case 13: per-egress rotation contract ───────────────────────────
test("--reset-until-clean soft-restarts first and spends no Cloudflare registration", async () => {
 let attempts = 0;
 const sc = newScenario({
  count: 2,
  throttle: {
   2: {
    "model-a": () => {
     attempts++;
     return attempts <= 1 ? { status: 429 } : null;
    },
   },
  },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", TARGET_MODEL: "model-a" },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 0, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.equal(lines.filter((l) => l.includes("rm -f /etc/wireguard/wg0.conf")).length, 0, "no wg0.conf deleted: tier-1 only");
 assert.equal(lines.filter((l) => l.startsWith("restart warp-relay-warp-2")).length, 1, "one soft restart");
 assert.match(r.stdout, /soft restart \(t1\)/);
 assert.match(r.stdout, /got 200 streaming \(CLEAN\)/);
});

test("--reset-until-clean escalates to a full reset when the soft restart cannot move the egress", async () => {
 const sc = newScenario({ count: 2, throttle: { 2: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  {
   ROTATE_SPACING_MS: "0",
   READY_TIMEOUT_MS: "4000",
   MAX_RESET_ATTEMPTS: "1",
   FAKE_DOCKER_STICKY_RESTARTS: "1",
   TARGET_MODEL: "model-a",
  },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.equal(lines.filter((l) => l.includes("rm -f /etc/wireguard/wg0.conf")).length, 1, "one full reset after the stuck soft restart");
 assert.equal(lines.filter((l) => l.startsWith("restart warp-relay-warp-2")).length, 2, "soft restart then full reset");
 assert.match(r.stdout, /kept the same egress — escalating to a full reset/);
});

test("--reset-until-clean rejects a new address inside the same throttled /64 and escalates", async () => {
 const sc = newScenario({ count: 2, throttle: { 2: { "model-a": { status: 429 } } } });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  {
   ROTATE_SPACING_MS: "0",
   READY_TIMEOUT_MS: "4000",
   MAX_RESET_ATTEMPTS: "1",
   FAKE_DOCKER_PREFIX_STICKY: "1",
   TARGET_MODEL: "model-a",
  },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.equal(lines.filter((l) => l.includes("rm -f /etc/wireguard/wg0.conf")).length, 1, "same-/64 address is not a fresh egress: full reset");
 assert.equal(lines.filter((l) => l.startsWith("restart warp-relay-warp-2")).length, 2, "soft restart then full reset");
 assert.match(r.stdout, /kept the same egress — escalating to a full reset/);
});

test("--reset-until-clean keeps rotating through multi-hour retry-after instead of halting", async () => {
 let attempts = 0;
 const sc = newScenario({
  count: 2,
  throttle: {
   2: {
    "model-a": () => {
     attempts++;
     return attempts <= 2 ? { status: 429, retryAfter: 25000 } : null;
    },
   },
  },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "4", TARGET_MODEL: "model-a" },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 0, r.stdout + r.stderr);
 const restarts = restartLines(sc);
 assert.equal(restarts.filter((l) => l.includes("warp-relay-warp-2")).length, 2, "kept rotating until the address streamed");
 assert.match(r.stdout, /retry-after: 25000/);
 assert.doesNotMatch(r.stdout, /Halting resets/);
 assert.match(r.stdout, /got 200 streaming \(CLEAN\)/);
});

test("--reset-until-clean keeps retrying a zero-yield round until MAX_RESET_ATTEMPTS", async () => {
 const sc = newScenario({
  count: 4,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
   3: { "model-a": { status: 429 } },
   4: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "2", TARGET_MODEL: "model-a" },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.equal(restartLines(sc).length, 8, "every relay rotates on both rounds; no zero-yield halt");
 assert.match(r.stdout, /round 2\/2/);
});

test("--reset-until-clean ceiling blocks tier-2 escalation but soft restarts continue", async () => {
 const sc = newScenario({
  count: 3,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
   3: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  {
   ROTATE_SPACING_MS: "0",
   MAX_RESET_ATTEMPTS: "2",
   SOFT_ROTATIONS_BEFORE_TIER2: "1",
   MAX_POOL_REGISTRATIONS_PER_HOUR: "1",
   TARGET_MODEL: "model-a",
  },
  ["--reset-until-clean"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.equal(lines.filter((l) => l.includes("rm -f /etc/wireguard/wg0.conf")).length, 1, "only one registration spent");
 assert.equal(restartLines(sc).length, 6, "all three relays still rotated on both rounds");
 assert.match(r.stdout, /\[ceiling\]/);
});
test("--reset-until-clean skips probing when fresh IP is in throttled prefix blacklist cache", async () => {
 const sc = newScenario({
  count: 1,
  throttle: { 1: { "model-a": { status: 429 } } },
 });
 // Pre-seed blacklist with the prefix that the fake docker returns on attempt 1 (2a09:2:1:0)
 fs.writeFileSync(
  sc.blacklistFile,
  JSON.stringify({ "2a09:2:1:0": Date.now() + 3600_000 }),
 );
 await startRelays(sc);
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "2", TARGET_MODEL: "model-a" },
  ["--reset-until-clean"],
 );
 assert.match(r.stdout, /in blacklist cache/);
});



test("--probe reports per-relay status without touching any container", async () => {
 const sc = newScenario({
  count: 3,
  throttle: { 2: { "model-a": { status: 429, retryAfter: 7200 } } },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { TARGET_MODEL: "model-a" }, ["--probe"]);
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.deepEqual(dockerLines(sc), [], "probe mode never invokes docker");
 assert.match(r.stdout, /#1 200 streaming/);
 assert.match(r.stdout, /#2 429 rate limited \(retry-after: 7200s\)/);
 assert.match(r.stdout, /probe summary: 2\/3 streaming 200/);
 assert.equal(fs.existsSync(sc.stateFile), false, "probe mode writes no state");
});

test("PROBE_FINGERPRINT=minimal strips fingerprint headers but keeps relay headers", async () => {
  const sc = newScenario({ count: 1 });
  await startRelays(sc);
  const logPath = path.join(sc.dir, "relay-1.log");
  const legacy = await runOnce(sc, { TARGET_MODEL: "model-a" }, ["--probe"]);
  assert.equal(legacy.code, 0, legacy.stdout + legacy.stderr);
  const legacyReq = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1));
  assert.equal(legacyReq.ua, "opencode/1.19.4");
  assert.equal(legacyReq.ocClient, "cli");
  assert.equal(legacyReq.auth, "Bearer public");
  assert.match(legacyReq.session, /^ses_/);
  assert.equal(legacyReq.tools, 6);
  assert.equal(legacyReq.relayTarget, "https://opencode.ai");
  assert.equal(legacyReq.keepCold, "1");
  fs.writeFileSync(logPath, "");
  const minimal = await runOnce(sc, { TARGET_MODEL: "model-a", PROBE_FINGERPRINT: "minimal" }, ["--probe"]);
  assert.equal(minimal.code, 0, minimal.stdout + minimal.stderr);
  const minimalReq = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1));
  assert.equal(minimalReq.ua, "keep-cold/1.0");
  assert.equal(minimalReq.ocClient, "");
  assert.equal(minimalReq.auth, "");
  assert.equal(minimalReq.session, "");
  assert.equal(minimalReq.tools, -1);
  assert.equal(minimalReq.relayTarget, "https://opencode.ai");
  assert.equal(minimalReq.keepCold, "1");
});

test("invalid PROBE_FINGERPRINT fails fast instead of probing", async () => {
  const sc = newScenario({ count: 1 });
  const r = await runOnce(sc, { PROBE_FINGERPRINT: "bogus" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PROBE_FINGERPRINT/);
});

test("legacy probe body carries exactly one env pair with Working directory", async () => {
  const sc = newScenario({ count: 1 });
  await startRelays(sc);
  const logPath = path.join(sc.dir, "relay-1.log");
  const legacy = await runOnce(sc, { TARGET_MODEL: "model-a" }, ["--probe"]);
  assert.equal(legacy.code, 0, legacy.stdout + legacy.stderr);
  const req = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1));
  assert.match(req.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "session id keeps the 12-hex+14-alnum gate shape");
  assert.equal((req.sys.match(/<env>/g) ?? []).length, 1, `exactly one <env> pair: ${req.sys}`);
  assert.equal((req.sys.match(/Working directory:/g) ?? []).length, 1, `exactly one Working directory pair: ${req.sys}`);
  fs.writeFileSync(logPath, "");
  const minimal = await runOnce(sc, { TARGET_MODEL: "model-a", PROBE_FINGERPRINT: "minimal" }, ["--probe"]);
  assert.equal(minimal.code, 0, minimal.stdout + minimal.stderr);
  const minReq = JSON.parse(fs.readFileSync(logPath, "utf8").trim().split("\n").at(-1));
  assert.equal(minReq.sys, "", "minimal mode sends no system block");

  const scR = newScenario({ count: 1 });
  await startRelays(scR);
  const rLog = path.join(scR.dir, "relay-1.log");
  const rProbe = await runOnce(scR, {
    PROBE_MODELS: "dots-studio/dots-3-note-preview:free",
    TARGET_MODEL: "dots-studio/dots-3-note-preview:free",
  }, ["--probe"]);
  assert.equal(rProbe.code, 0, rProbe.stdout + rProbe.stderr);
  const rReq = JSON.parse(fs.readFileSync(rLog, "utf8").trim().split("\n").at(-1));
  assert.equal((rReq.sys.match(/<env>/g) ?? []).length, 1, `responses path carries one <env> pair: ${rReq.sys}`);
  assert.equal((rReq.sys.match(/Working directory:/g) ?? []).length, 1, `responses path carries Working directory: ${rReq.sys}`);
});

test("429 scheduling log carries redacted fp descriptor in both modes", async () => {
  const throttle = { 1: { "model-a": { status: 429, retryAfter: 30 } } };
  const scLegacy = newScenario({ count: 2, throttle });
  await startRelays(scLegacy);
  const rLegacy = await runOnce(scLegacy);
  assert.equal(rLegacy.code, 1, rLegacy.stdout + rLegacy.stderr);
  assert.match(rLegacy.stdout, /#1 retry-after 30s — scheduling, no restart \(fp=legacy\/tools=6\/auth=1\/sid=.{10}\)/);
  assert.doesNotMatch(rLegacy.stdout, /Bearer public/);
  assert.doesNotMatch(rLegacy.stdout, /ses_[0-9a-f]{12}[0-9A-Za-z]{14}/);
  const scMinimal = newScenario({ count: 2, throttle: { 1: { "model-a": { status: 429, retryAfter: 30 } } } });
  await startRelays(scMinimal);
  const rMinimal = await runOnce(scMinimal, { PROBE_FINGERPRINT: "minimal" });
  assert.equal(rMinimal.code, 1, rMinimal.stdout + rMinimal.stderr);
  assert.match(rMinimal.stdout, /#1 retry-after 30s — scheduling, no restart \(fp=minimal\/tools=0\/auth=0\/sid=.{10}\)/);
  assert.doesNotMatch(rMinimal.stdout, /Bearer public/);
  assert.doesNotMatch(rMinimal.stdout, /ses_[0-9a-f]{12}[0-9A-Za-z]{14}/);
});

test("auto-discovers popular free models (deepseek, glm, mimo) from OpenCode by default", async () => {
 const sc = newScenario({ count: 1 });
 await startRelays(sc);
 const mockPort = takeBlock();
 const mockServer = http.createServer((req, res) => {
  if (req.url === "/opencode.ai/inference/v1/models") {
   res.writeHead(200, { "content-type": "application/json" });
   res.end(
    JSON.stringify({
     data: [
      { id: "deepseek-v4.1-flash-free" },
      { id: "mimo-v2.6-flash-free" },
      { id: "paid-gpt-4o" },
      { id: "jev-1.13-free" },
      { id: "glm-5.3-flash-free" },
      { id: "nemotron-3.5-lightning-free" },
     ],
    }),
   );
   return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: {}\\n\\n");
 });
 servers.push(mockServer);
 await new Promise((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

 const r = await runOnce(sc, {
  PROBE_TARGET: `http://127.0.0.1:${mockPort}/opencode.ai`,
  PROBE_MODELS: undefined,
 });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.match(r.stdout, /auto-discovered 3 free model\(s\) from OpenCode/);
 assert.match(r.stdout, /deepseek-v4.1-flash-free/);
 assert.match(r.stdout, /glm-5.3-flash-free/);
 assert.match(r.stdout, /mimo-v2.6-flash-free/);
 assert.doesNotMatch(r.stdout, /nemotron-3.5-lightning-free/);
 assert.doesNotMatch(r.stdout, /paid-gpt-4o/);
});

test("auto-discovers all free models when PROBE_MODELS_MODE is set to all", async () => {
 const sc = newScenario({ count: 1 });
 await startRelays(sc);
 const mockPort = takeBlock();
 const mockServer = http.createServer((req, res) => {
  if (req.url === "/opencode.ai/inference/v1/models") {
   res.writeHead(200, { "content-type": "application/json" });
   res.end(
    JSON.stringify({
     data: [
      { id: "deepseek-v4.1-flash-free" },
      { id: "mimo-v2.6-flash-free" },
      { id: "paid-gpt-4o" },
      { id: "glm-5.3-flash-free" },
      { id: "nemotron-3.5-lightning-free" },
     ],
    }),
   );
   return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: {}\\n\\n");
 });
 servers.push(mockServer);
 await new Promise((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

 const r = await runOnce(sc, {
  PROBE_TARGET: `http://127.0.0.1:${mockPort}/opencode.ai`,
  PROBE_MODELS: undefined,
  PROBE_MODELS_MODE: "all",
 });
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.match(r.stdout, /auto-discovered 4 free model\(s\) from OpenCode/);
 assert.match(r.stdout, /nemotron-3.5-lightning-free/);
});

test("falls back to default OpenCode free models if discovery endpoint fails", async () => {
 const sc = newScenario({ count: 1 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  {
   PROBE_TARGET: "http://127.0.0.1:24999/opencode.ai",
   PROBE_MODELS: undefined,
  },
  ["--probe"],
 );
 assert.match(r.stdout, /deepseek-v4.1-flash-free/);
});
// ── --sweep mode ────────────────────────────────────────────────────
test("--sweep probes all relays, rotates throttled ones until clean, exits 0 when floor reached", async () => {
 let attempts = 0;
 const sc = newScenario({
  count: 4,
  throttle: {
   2: {
    "model-a": () => {
     attempts++;
     return attempts <= 1 ? { status: 429 } : null;
    },
   },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { ROTATE_SPACING_MS: "0", MIN_CLEAN_COUNT: "3" }, ["--sweep"]);
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.match(r.stdout, /full sweep: 4 relay\(s\)/);
 assert.equal(touchedRelays(sc).length, 4, "all relays probed");
 assert.match(r.stdout, /rotating 1 rate-limited relay\(s\)/);
 assert.match(r.stdout, /soft restart \(t1\)/);
 assert.match(r.stdout, /clean on all 1 model\(s\)/);
 assert.match(r.stdout, /pool is safe/);
});

test("--sweep leaves quota-capped relays alone", async () => {
 const sc = newScenario({
  count: 4,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
   3: { "model-a": { status: 429 } },
   4: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(sc, { SWEEP_QUOTA_GUARD: "4" }, ["--sweep"]);
 assert.match(r.stdout, /upstream quota, skipping rotation/);
 assert.deepEqual(restartLines(sc), [], "quota-capped: no restarts");
 assert.match(r.stdout, /pool is degraded/);
});

test("--sweep exits 0 when clean count meets floor even with some still throttled", async () => {
 const sc = newScenario({
  count: 4,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 // MAX_RESET_ATTEMPTS=1, relays stay throttled; floor=2 → 2 clean already OK
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "1", MIN_CLEAN_COUNT: "2" },
  ["--sweep"],
 );
 assert.equal(r.code, 0, r.stdout + r.stderr);
 assert.match(r.stdout, /sweep result: 2\/4 relay\(s\) clean/);
 assert.match(r.stdout, /safe floor 2/);
 assert.match(r.stdout, /pool is safe/);
});

test("--sweep exits 1 when clean count is below floor", async () => {
 const sc = newScenario({
  count: 4,
  throttle: {
   1: { "model-a": { status: 429 } },
   2: { "model-a": { status: 429 } },
   3: { "model-a": { status: 429 } },
  },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  { ROTATE_SPACING_MS: "0", MAX_RESET_ATTEMPTS: "1", MIN_CLEAN_COUNT: "3" },
  ["--sweep"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 assert.match(r.stdout, /pool is degraded/);
});

test("--sweep escalates to tier-2 when soft restart cannot move the /64", async () => {
 const sc = newScenario({
  count: 2,
  throttle: { 2: { "model-a": { status: 429 } } },
 });
 await startRelays(sc);
 const r = await runOnce(
  sc,
  {
   ROTATE_SPACING_MS: "0",
   READY_TIMEOUT_MS: "4000",
   MAX_RESET_ATTEMPTS: "1",
   FAKE_DOCKER_STICKY_RESTARTS: "1",
   MIN_CLEAN_COUNT: "2",
  },
  ["--sweep"],
 );
 assert.equal(r.code, 1, r.stdout + r.stderr);
 const lines = dockerLines(sc);
 assert.ok(lines.some((l) => l.includes("rm -f /etc/wireguard/wg0.conf")), "escalated to tier-2");
 assert.match(r.stdout, /escalating to a full reset/);
});
