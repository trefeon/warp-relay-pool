#!/usr/bin/env node
/**
 * keep-cold.mjs — MicroWARP egress prober/rotator (serverError class 2026-10-05).
 *
 * Every relay in this pool reaches the upstream through its own Cloudflare WARP
 * client container, so each has its own egress IPv6 address. Cloudflare recycles
 * those addresses across public WARP users, which means a container can come up
 * already throttled by the upstream provider (HTTP 429) even though the relay
 * itself is perfectly healthy.
 *
 * Throttling is PER MODEL per egress IP: warp-1 can serve nemotron 200 while
 * answering 429 for mimo-v2.5 on the same address (observed 2026-10-02), so a
 * single-model probe misses throttled relays. This script probes every relay
 * with a real streaming inference request for EACH model in PROBE_MODELS
 * (chat + responses paths) and, for any relay throttled on any model, restarts
 * ONLY that relay's WARP client container until every probed model answers
 * 200 (bounded by MAX_ROTATIONS per relay per pass).
 *
 * A model throttled on a MAJORITY of relays is treated as upstream model
 * quota (no egress rotation can fix it): it is skipped for rotation decisions
 * this pass (see GLOBAL_QUOTA_GUARD), so one globally-capped probe model can
 * never churn all 10 WARP clients pointlessly.
 *
 * Upstream server_error ("The model failed to generate a response") is its own
 * class between hot/429 (rotate) and troubled (never rotate), in two shapes:
 * transport (non-200 JSON carrying server_error) and envelope (HTTP 200 SSE
 * carrying response.failed/server_error — probe() reads the first 2 chunks,
 * ~4KB cap, before declaring clean). Per pass and per relay: 1 same-egress
 * re-probe after ~5s (transient filter), then a SINGLE tier-1 restart only
 * (zero registration cost), then hold to next pass when still failing — never
 * tier-2. A model failing on SERVER_ERROR_GUARD relays is an upstream
 * incident: rotation is skipped for it this pass. Holds exit 1 like troubled.
 *
 * Speed ranking is logged per pass but rotation on speed is DISABLED
 * (SLOW_THRESHOLD_MS=0): the 2026-10-02 trial falsified single-sample rank as
 * an egress signal — #5 ranked slowest (9920ms) then 2nd-fastest (1292ms)
 * minutes later, #8 fastest (1867ms) then mid-pack. Rank reshuffles fully
 * between passes = upstream variance, not egress quality. Every pass still
 * logs `speed <model>: #N Nms …` for observability; re-enable rotation only
 * with median-over-N-passes proof.
 *
 * The public relay URLs never change: the `*.trycloudflare.com` tunnels and the
 * relay application are different containers and are never touched here. Only
 * `warp-relay-warp-N` is ever restarted, so every URL already configured in the
 * client pool keeps working through the rotation.
 *
 * Usage:
 *   node keep-cold.mjs --once                 # single pass, exit 0 when all clean
 *   node keep-cold.mjs --loop                 # pass every INTERVAL_S seconds
 *   INTERVAL_S=600 node keep-cold.mjs --loop
 *
 * Environment:
 *   RELAY_HOST          relay app bridge address      (default 10.244.0.100)
 *   BASE_PORT           first relay port              (default 3000)
 *   COUNT               number of relays              (default 10)
 *   SOCKS_HOST          host dialed for the SOCKS readiness/egress probes
 *                       (default 127.0.0.1; set this to the WARP_BIND address
 *                       when the SOCKS family is bound to an
 *                       interface-specific address, since loopback then has
 *                       no listener. 0.0.0.0 binds still answer on loopback)
 *   PROBE_TARGET        upstream the probes go through (default
 *                       https://api.kilo.ai — the lane clients actually
 *                       use; OpenCode's Zen free tier has refused every
 *                       non-OpenCode client with 403 FreeTierError since
 *                       2026-10-14, fingerprints included)
 *   PROBE_CHAT_PATH     chat wire path under PROBE_TARGET (default
 *                       /api/gateway/chat/completions)
 *   PROBE_RESPONSES_PATH  responses wire path under PROBE_TARGET (default
 *                       /api/gateway/responses)
 *   PROBE_MODELS        comma-separated models to probe (default
 *                       nvidia/nemotron-3.5-lightning:free,
 *                       cohere/north-mini-code:free,
 *                       dots-studio/dots-3-note-preview:free — three
 *                       families so per-model throttles stay
 *                       distinguishable)
 *   PROBE_MODEL         legacy single-model override (used only when
 *                       PROBE_MODELS is unset)
 *   RESPONSES_MODELS    comma-separated models probed via
 *                       PROBE_RESPONSES_PATH (default
 *                       dots-studio/dots-3-note-preview:free; everything
 *                       else probes via PROBE_CHAT_PATH)
 *   GLOBAL_QUOTA_GUARD  relays-429ed threshold at which a model counts as
 *                       upstream quota, not egress throttle (default
 *                       max(8, COUNT-1), capped at COUNT). Quota-capped
 *                       models are skipped for rotation this pass.
 *   SERVER_ERROR_RETRY    same-egress re-probes before a server_error
 *                       rotation (default 1 — stateless transient filter)
 *   SERVER_ERROR_REPROBE_MS  delay before each re-probe (default 5000)
 *   SERVER_ERROR_GUARD    relays-with-server_error threshold at which a model
 *                       counts as upstream incident, not egress fault
 *                       (default 9, capped at COUNT)
 *   SPEED_MODEL         model whose latency decides slow rotation (default
 *                       nvidia/nemotron-3.5-lightning:free; must be in
 *                       PROBE_MODELS to have timings)
 *   SLOW_THRESHOLD_MS   200-response slower than this is rotated for speed
 *                       (default 0 = DISABLED — single-sample rank proven
 *                       upstream noise 2026-10-02; re-enable only on
 *                       median-over-N evidence)
 *   SLOW_MAX_ROTATIONS  restarts per slow relay per pass (default 2 —
 *                       separate budget from the 429 path)
 *   CONTAINER_PREFIX    docker container prefix       (default warp-relay-warp-)
 *   READY_TIMEOUT_MS    wait for a rotated relay      (default 180000)
 *   PROBE_TIMEOUT_MS    per-probe request timeout     (default 30000)
 *   MAX_ROTATIONS       tier-1 restarts per relay per pass (default 4;
 *                       tier 2 runs at most once per relay per pass)
 *   TIER2_MIN_INTERVAL_S  minimum seconds between tier-2 re-keys for one
 *                       relay, persisted in TIER2_STATE_FILE (default 3600)
 *   ROTATE_CONCURRENCY  parallel restarts             (default 1)
 *   INTERVAL_S          seconds between loop passes   (default 300)
 *   SOCKS_PORT_BASE     host SOCKS port for relay N   (default 10800)
 *   KEEP_COLD_LOG       append the log to this file   (default stdout only)
 *   KEEP_COLD_LOG_MAX_BYTES  rotate above this size    (default 2 MiB)
 *   KEEP_COLD_LOG_KEEP_BYTES keep this much on rotate   (default 200 KiB)
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const USAGE = `Usage: node keep-cold.mjs [--once|--loop] [--help]

  --once   single pass (the default; what the systemd timer runs)
  --loop   pass every INTERVAL_S seconds (foreground)
  --help   print this text and exit`;

const argv = process.argv.slice(2);
const unknownArgs = argv.filter((a) => !["--once", "--loop", "--help", "-h"].includes(a));
if (unknownArgs.length) {
 console.error(`keep-cold: unknown argument(s): ${unknownArgs.join(" ")}`);
 console.error(USAGE);
 process.exit(2);
}
if (argv.includes("--help") || argv.includes("-h")) {
 console.log(USAGE);
 process.exit(0);
}
const LOOP = argv.includes("--loop");
if (LOOP && argv.includes("--once")) {
 console.error("keep-cold: --once and --loop are mutually exclusive");
 process.exit(2);
}

/**
 * Parse an integer env var, failing fast on blank/garbage values. A silent
 * fallback here used to turn a pass into a no-op that still exited 0.
 */
function envInt(name, dflt, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
 const raw = process.env[name];
 if (raw === undefined) return dflt;
 if (raw.trim() === "") {
  console.error(`keep-cold: ${name} is set but blank`);
  process.exit(2);
 }
 if (!/^-?\d+$/.test(raw.trim())) {
  console.error(`keep-cold: ${name}='${raw}' must be an integer`);
  process.exit(2);
 }
 const n = Number(raw.trim());
 if (!Number.isSafeInteger(n) || n < min || n > max) {
  console.error(`keep-cold: ${name}='${raw}' must be an integer in ${min}..${max}`);
  process.exit(2);
 }
 return n;
}

function envPath(name, dflt) {
 const value = process.env[name] ?? dflt;
 if (!value.startsWith("/")) {
  console.error(`keep-cold: ${name}='${value}' must be a rooted path`);
  process.exit(2);
 }
 return value;
}

function envUrl(name, dflt) {
 const value = (process.env[name] ?? dflt).replace(/\/+$/, "");
 try {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
 } catch {
  console.error(`keep-cold: ${name}='${value}' is not a valid http(s) URL`);
  process.exit(2);
 }
 return value;
}

const RELAY_HOST = process.env.RELAY_HOST ?? "10.244.0.100";
const SOCKS_HOST = process.env.SOCKS_HOST ?? "127.0.0.1";
const BASE_PORT = envInt("BASE_PORT", 3000, { max: 65535 });
const COUNT = envInt("COUNT", 10, { min: 1, max: 64 });
const SOCKS_PORT_BASE = envInt("SOCKS_PORT_BASE", 10800, { min: 1, max: 65535 });
const PROBE_TARGET = envUrl("PROBE_TARGET", "https://api.kilo.ai");
const PROBE_CHAT_PATH = envPath("PROBE_CHAT_PATH", "/api/gateway/chat/completions");
const PROBE_RESPONSES_PATH = envPath("PROBE_RESPONSES_PATH", "/api/gateway/responses");
const PROBE_MODELS = (process.env.PROBE_MODELS
 ?? process.env.PROBE_MODEL
 ?? "nvidia/nemotron-3.5-lightning:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free")
 .split(",")
 .map((s) => s.trim())
 .filter(Boolean);
if (PROBE_MODELS.length === 0) {
 console.error("keep-cold: PROBE_MODELS is empty — nothing to probe");
 process.exit(2);
}
const RESPONSES_MODELS = new Set(
 (process.env.RESPONSES_MODELS
  ?? "dots-studio/dots-3-note-preview:free")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean),
);
const GLOBAL_QUOTA_GUARD = Math.min(envInt("GLOBAL_QUOTA_GUARD", Math.max(8, COUNT - 1), { min: 1 }), COUNT);
const SPEED_MODEL = process.env.SPEED_MODEL ?? "nvidia/nemotron-3.5-lightning:free";
const SLOW_THRESHOLD_MS = envInt("SLOW_THRESHOLD_MS", 0);
const SLOW_MAX_ROTATIONS = envInt("SLOW_MAX_ROTATIONS", 2);
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX ?? "warp-relay-warp-";
const READY_TIMEOUT_MS = envInt("READY_TIMEOUT_MS", 180_000, { min: 1 });
const PROBE_TIMEOUT_MS = envInt("PROBE_TIMEOUT_MS", 30_000, { min: 1 });
const MAX_ROTATIONS = envInt("MAX_ROTATIONS", 4, { min: 1 });
const ROTATE_CONCURRENCY = envInt("ROTATE_CONCURRENCY", 1, { min: 1, max: 64 });
const SERVER_ERROR_RETRY = envInt("SERVER_ERROR_RETRY", 1);
const SERVER_ERROR_REPROBE_MS = envInt("SERVER_ERROR_REPROBE_MS", 5_000);
const SERVER_ERROR_GUARD = Math.min(envInt("SERVER_ERROR_GUARD", 9, { min: 1 }), COUNT);
const INTERVAL_S = envInt("INTERVAL_S", 300, { min: 1 });
const TIER2_MIN_INTERVAL_S = envInt("TIER2_MIN_INTERVAL_S", 3600);
const TIER2_STATE_FILE = process.env.TIER2_STATE_FILE ?? ".keep-cold/tier2-state.json";

// ── Upstream fingerprint ────────────────────────────────────────────
// Historically OpenCode's free tier rejected requests that did not look like
// the official client, so the probe carried the same headers and tool
// declarations the proxy sends — a 403 would have hidden the 429 we are
// looking for. Since 2026-10-14 that tier refuses every non-OpenCode client
// regardless of shape (403 FreeTierError), so the defaults target the Kilo
// lane, where these headers are ignored but harmless; the fingerprint is
// kept for pools still pointed at opencode.ai via PROBE_TARGET.
const OPENCODE_CLIENT = "cli";
const OPENCODE_PROJECT = createHash("sha1")
 .update("git-remote:github.com/anomalyco/opencode")
 .digest("hex");
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `ses_` + 12 hex + 14 alphanumeric, the shape the upstream gate validates. */
function sessionId() {
 const hex = randomBytes(6).toString("hex");
 let rest = "";
 const bytes = randomBytes(14);
 for (let i = 0; i < 14; i++) rest += ID_CHARS[bytes[i] % ID_CHARS.length];
 return `ses_${hex}${rest}`;
}

const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read", "edit", "write"];
// Chat Completions placeholder shape: { type, function: { name, ... } }.
const PLACEHOLDER_TOOLS = FINGERPRINT_TOOLS.map((name) => ({
 type: "function",
 function: { name, description: `${name} (probe)`, parameters: { type: "object", properties: {} } },
}));
// Responses placeholder shape: flat { type, name, ... }.
const RESPONSE_PLACEHOLDER_TOOLS = FINGERPRINT_TOOLS.map((name) => ({
 type: "function",
 name,
 description: `${name} (probe)`,
 parameters: { type: "object", properties: {} },
}));

/** Build the wire-path + body for a probed model (chat vs responses). */
function buildProbe(model) {
 if (RESPONSES_MODELS.has(model)) {
  return {
   relayPath: PROBE_RESPONSES_PATH,
   body: JSON.stringify({
    model,
    input: "ping",
    stream: true,
    tools: RESPONSE_PLACEHOLDER_TOOLS,
   }),
  };
 }
 return {
  relayPath: PROBE_CHAT_PATH,
  body: JSON.stringify({
   model,
   stream: true,
   max_tokens: 4,
   messages: [{ role: "user", content: "ping" }],
   tools: PLACEHOLDER_TOOLS,
  }),
 };
}

function probeHeaders(relayPath) {
 return {
  "content-type": "application/json",
  "user-agent": "opencode/1.18.31",
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": OPENCODE_PROJECT,
  "x-opencode-session": sessionId(),
  "x-opencode-request": `msg_${randomBytes(6).toString("hex")}${randomBytes(14).toString("base64url").slice(0, 14)}`,
  // Route through the in-container relay app; the public tunnel is bypassed
  // on purpose so a rotation never depends on tunnel state.
  "x-relay-target": PROBE_TARGET,
  "x-relay-path": relayPath,
  accept: "text/event-stream",
 };
}

// ── Logging ─────────────────────────────────────────────────────────
const LOG_PATH = process.env.KEEP_COLD_LOG ?? "";
const LOG_MAX_BYTES = envInt("KEEP_COLD_LOG_MAX_BYTES", 2 * 1024 * 1024, { min: 1 });
const LOG_KEEP_BYTES = envInt("KEEP_COLD_LOG_KEEP_BYTES", 200 * 1024, { min: 1 });
if (LOG_KEEP_BYTES >= LOG_MAX_BYTES) {
 console.error("keep-cold: KEEP_COLD_LOG_KEEP_BYTES must be smaller than KEEP_COLD_LOG_MAX_BYTES");
 process.exit(2);
}

/** Trim the log once it passes the cap, keeping the newest whole lines. */
function rotateLogIfNeeded() {
 try {
  if (fs.statSync(LOG_PATH).size <= LOG_MAX_BYTES) return;
  const buf = fs.readFileSync(LOG_PATH);
  const tail = buf.subarray(Math.max(0, buf.length - LOG_KEEP_BYTES));
  const nl = tail.indexOf(0x0a);
  const kept = nl >= 0 ? tail.subarray(nl + 1) : tail;
  // temp+rename: a kill mid-rotation must not lose the whole log, and a
  // concurrent manual run must not interleave with a truncate-then-write.
  const tmp = `${LOG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept);
  fs.renameSync(tmp, LOG_PATH);
 } catch {
  // Missing log file — nothing to rotate.
 }
}

/** Always to stdout (journald captures it); optionally also to a file. */
function log(msg) {
 const line = `[${new Date().toISOString()}] ${msg}\n`;
 process.stdout.write(line);
 if (!LOG_PATH) return;
 try {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_PATH, line);
 } catch {
  // Logging must never break a pass.
 }
}

// ── Docker helpers ──────────────────────────────────────────────────
function containerName(index) {
 return `${CONTAINER_PREFIX}${index}`;
}

async function docker(args, timeout = 30_000) {
 const { stdout } = await execFileAsync("docker", args, {
  encoding: "utf8",
  timeout,
  maxBuffer: 4 * 1024 * 1024,
 });
 return stdout;
}

/** True when the WARP client egresses with WARP on (host-side SOCKS check). */
async function warpReady(index) {
 try {
  // MicroWARP has no warp-cli and no guaranteed curl — check from the deploy
  // host via SOCKS instead of docker-exec.
  const { stdout } = await execFileAsync(
   "curl",
   ["-s", "-m", "10", "-x", `socks5h://${SOCKS_HOST}:${SOCKS_PORT_BASE + index}`, "https://cloudflare.com/cdn-cgi/trace"],
   { encoding: "utf8", timeout: 15_000 },
  );
  return /^ip=/m.test(stdout) && /warp=on/m.test(stdout);
 } catch {
  return false;
 }
}

/** Egress address of a relay, for the log line. */
async function egressIp(index) {
 try {
  // MicroWARP has no docker-exec curl — probe from the deploy host via SOCKS.
  const { stdout } = await execFileAsync(
   "curl",
   ["-s", "-m", "10", "-x", `socks5h://${SOCKS_HOST}:${SOCKS_PORT_BASE + index}`, "https://cloudflare.com/cdn-cgi/trace"],
   { encoding: "utf8", timeout: 15_000 },
  );
  return (stdout.match(/^ip=(.+)$/m)?.[1] ?? "?").trim();
 } catch {
  return "?";
 }
}

async function waitReady(index, deadline) {
 while (Date.now() < deadline) {
  if (await warpReady(index)) return true;
  await new Promise((r) => setTimeout(r, 4_000));
 }
 return false;
}

/** Matches both server_error shapes: transport JSON and 200-SSE envelope. */
const SERVER_ERROR_RE = /server_error|response\.failed|failed to generate/i;

/** Transport shape: non-200/non-429 JSON carrying the upstream failure. */
function isServerError(status, detail) {
 if (status === 200 || status === 429 || status === 0) return false;
 return SERVER_ERROR_RE.test(detail ?? "");
}

/**
 * Read at most the first 2 SSE chunks (~4KB cap) of a 200 body, then cancel.
 * Envelope-shape server_error hides inside 200 streams, which the old
 * cancel-unread probe counted as clean.
 */
async function readEnvelopeHead(res) {
 const reader = res.body?.getReader?.();
 if (!reader) {
  await res.body?.cancel().catch(() => { });
  return "";
 }
 const dec = new TextDecoder();
 let head = "";
 try {
  for (let n = 0; n < 2; n++) {
   const { done, value } = await reader.read();
   if (done) break;
   head += dec.decode(value, { stream: true });
   if (head.length >= 4096) break;
  }
 } finally {
  await reader.cancel().catch(() => { });
 }
 return head.slice(0, 4096);
}

// ── Probing ─────────────────────────────────────────────────────────
async function probe(index, model) {
 const url = `http://${RELAY_HOST}:${BASE_PORT + index}`;
 const { relayPath, body } = buildProbe(model);
 const t0 = Date.now();
 try {
  const res = await fetch(url, {
   method: "POST",
   headers: probeHeaders(relayPath),
   body,
   signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status === 200) {
   // A body that dies mid-read is a wedged egress, not a clean probe: the
   // old `.catch(() => "")` silently turned it into a 200.
   let head;
   try {
    head = await readEnvelopeHead(res);
   } catch (e) {
    return { index, model, status: 0, serverError: false, detail: `body read failed: ${String(e?.message ?? e)}`.slice(0, 160), ms: Date.now() - t0 };
   }
   const ms = Date.now() - t0;
   if (SERVER_ERROR_RE.test(head)) {
    const evt = /response\.failed/i.test(head) ? "response.failed" : /failed to generate/i.test(head) ? "failed to generate" : "server_error";
    return { index, model, status: 200, serverError: true, detail: `envelope SSE ${evt}: ${head.replace(/\s+/g, " ").slice(0, 120)}`, ms };
   }
   return { index, model, status: 200, serverError: false, detail: "", ms };
  }
  const text = await res.text().catch(() => "");
  const detail = text.replace(/\s+/g, " ").slice(0, 160);
  return { index, model, status: res.status, serverError: isServerError(res.status, detail), detail, ms: Date.now() - t0 };
 } catch (e) {
  return { index, model, status: 0, serverError: false, detail: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0 };
 }
}

/** Probe a set of models on one relay (serial — one relay, one egress). */
async function probeRelay(index, models = PROBE_MODELS) {
 const out = [];
 for (const model of models) out.push(await probe(index, model));
 return out;
}

// Tier-2 spends a Cloudflare registration. One per relay per pass is the
// budget; the state file keeps a stuck relay from re-spending it on every
// 5-minute timer tick.
function loadTier2State() {
 try {
  return JSON.parse(fs.readFileSync(TIER2_STATE_FILE, "utf8")) ?? {};
 } catch {
  return {};
 }
}

function saveTier2State(index, stamp) {
 try {
  fs.mkdirSync(path.dirname(TIER2_STATE_FILE), { recursive: true });
  // Concurrent rotations each hold a snapshot from pass start; merge against
  // the current file so a slow writer cannot erase another relay's stamp.
  const merged = { ...loadTier2State(), [index]: stamp };
  const tmp = `${TIER2_STATE_FILE}.${process.pid}.${index}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged));
  fs.renameSync(tmp, TIER2_STATE_FILE);
 } catch {
  // State is an optimization; never fail a pass over it.
 }
}

function tier2Allowed(index, state) {
 if (TIER2_MIN_INTERVAL_S === 0) return true;
 return Date.now() - Number(state[index] ?? 0) >= TIER2_MIN_INTERVAL_S * 1000;
}

/**
 * Restart the WARP client container until every given model answers 200
 * (and, when `speed` is set, the speed model answers within threshold).
 * 429 path uses MAX_ROTATIONS; speed-only retries use SLOW_MAX_ROTATIONS.
 * Two-tier: tier 1 (t1) plain restart, tier 2 (t2) exec-wipe of wg0.conf +
 * restart at most once per relay per pass (and not again for
 * TIER2_MIN_INTERVAL_S). Nodes without wg0.conf skip tier 2.
 */
async function rotateUntilClean(index, models, speed = null) {
 const maxAttempts = speed ? SLOW_MAX_ROTATIONS : MAX_ROTATIONS;
 const tier2State = loadTier2State();
 let rekeys = 0;
 let latestFailing = null;
 for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  log(`#${index} rotating egress (attempt ${attempt}/${maxAttempts} t1) — restarting ${containerName(index)}`);
  try {
   // Tier 1: plain restart - same account, fresh egress /64. Cheap, zero
   // registration-quota cost; clears per-egress-IP throttles.
   await docker(["restart", containerName(index)], 60_000);
  } catch (e) {
   log(`#${index} restart failed: ${String(e?.message ?? e).slice(0, 120)}`);
   continue;
  }
  const ready = await waitReady(index, Date.now() + READY_TIMEOUT_MS);
  if (!ready) {
   log(`#${index} WARP client did not come up within ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
   continue;
  }
  const results = await probeRelay(index, models);
  const failing = results.filter((r) => r.status !== 200 || r.serverError);
  latestFailing = failing;
  if (failing.length === 0) {
   if (speed) {
    const t = results.find((r) => r.model === speed.model)?.ms ?? Infinity;
    if (t <= speed.threshold) {
     log(`#${index} fast on ${models.length} model(s) (${speed.model} ${t}ms) — new egress ${await egressIp(index)}`);
     return true;
    }
    log(`#${index} still slow after rotation: ${speed.model} ${t}ms > ${speed.threshold}ms`);
    continue;
   }
   log(`#${index} clean on ${models.length} model(s) — new egress ${await egressIp(index)}`);
   return true;
  }
  // Tier 2: tier 1 did not clear it - re-key with a fresh registration (new
  // account/keys). Spends one Cloudflare registration; clears per-account
  // throttles. Nodes without wg0.conf (e.g. caomingjun) are not re-keyable:
  // abort the re-key instead of forcing a wipe.
  if (rekeys >= 1) {
   log(`#${index} tier-2 budget spent this pass — holding for the next pass`);
   latestFailing = failing;
   continue;
  }
  if (!tier2Allowed(index, tier2State)) {
   const nextIn = Math.max(0, Math.ceil((TIER2_MIN_INTERVAL_S * 1000 - (Date.now() - Number(tier2State[index] ?? 0))) / 1000));
   log(`#${index} tier-2 re-key deferred (last re-key < ${TIER2_MIN_INTERVAL_S}s ago; next in ~${nextIn}s)`);
   latestFailing = failing;
   continue;
  }
  rekeys++;
  const tier2Stamp = Date.now();
  tier2State[index] = tier2Stamp;
  saveTier2State(index, tier2Stamp);
  log(`#${index} rotating egress (attempt ${attempt}/${maxAttempts} t2) — re-keying ${containerName(index)}`);
  let rekeyable = true;
  try {
   await docker(["exec", containerName(index), "test", "-f", "/etc/wireguard/wg0.conf"], 30_000);
  } catch {
   rekeyable = false;
  }
  if (!rekeyable) {
   log(`#${index} tier-2 aborted: no /etc/wireguard/wg0.conf — leaving registration untouched`);
  } else {
   try {
    await docker(["exec", containerName(index), "rm", "-f", "/etc/wireguard/wg0.conf"], 30_000);
    await docker(["restart", containerName(index)], 60_000);
   } catch (e) {
    log(`#${index} restart failed: ${String(e?.message ?? e).slice(0, 120)}`);
    continue;
   }
   const ready2 = await waitReady(index, Date.now() + READY_TIMEOUT_MS);
   if (!ready2) {
    log(`#${index} WARP client did not come up within ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
    continue;
   }
   const results2 = await probeRelay(index, models);
   const failing2 = results2.filter((r) => r.status !== 200 || r.serverError);
   latestFailing = failing2;
   if (failing2.length === 0) {
    if (speed) {
     const t2 = results2.find((r) => r.model === speed.model)?.ms ?? Infinity;
     if (t2 <= speed.threshold) {
      log(`#${index} fast on ${models.length} model(s) (${speed.model} ${t2}ms) — new egress ${await egressIp(index)}`);
      return true;
     }
     log(`#${index} still slow after rotation: ${speed.model} ${t2}ms > ${speed.threshold}ms`);
     continue;
    }
    log(`#${index} clean on ${models.length} model(s) — new egress ${await egressIp(index)}`);
    return true;
   }
  }
  log(`#${index} still failing after rotation: ${(latestFailing ?? failing).map((r) => `${r.model}=${r.status || "unreachable"}`).join(", ")}`);
 }
 log(`#${index} GAVE UP after ${maxAttempts} rotations`);
 return false;
}

/**
 * Single tier-1 restart for the server_error path: plain restart (same
 * account, fresh egress /64 — zero registration cost), then re-probe.
 * NEVER tier-2 here: a server_error rotation must not spend Cloudflare
 * registrations, so a still-failing relay holds instead of re-keying.
 */
async function rotateTier1Once(index, models) {
 log(`#${index} rotating egress (t1 server_error) — restarting ${containerName(index)}`);
 try {
  await docker(["restart", containerName(index)], 60_000);
 } catch (e) {
  log(`#${index} restart failed: ${String(e?.message ?? e).slice(0, 120)}`);
  return false;
 }
 const ready = await waitReady(index, Date.now() + READY_TIMEOUT_MS);
 if (!ready) {
  log(`#${index} WARP client did not come up within ${Math.round(READY_TIMEOUT_MS / 1000)}s`);
  return false;
 }
 const results = await probeRelay(index, models);
 const failing = results.filter((r) => r.status !== 200 || r.serverError);
 if (failing.length === 0) {
  log(`#${index} clean on ${models.length} model(s) — new egress ${await egressIp(index)}`);
  return true;
 }
 log(`#${index} still failing after t1: ${failing.map((r) => `${r.model}=${r.serverError ? "server_error" : (r.status || "unreachable")}`).join(", ")}`);
 return false;
}

/**
 * server_error handling for one relay: same-egress re-probe(s) first
 * (stateless transient filter), then at most ONE tier-1 restart.
 * Returns { recovered, restarted }.
 */
async function handleServerError(index, models) {
 for (let a = 0; a < SERVER_ERROR_RETRY; a++) {
  await new Promise((r) => setTimeout(r, SERVER_ERROR_REPROBE_MS));
  const retry = [];
  for (const m of models) retry.push(await probe(index, m));
  const still = retry.filter((r) => r.status !== 200 || r.serverError);
  for (const r of retry) {
   if (r.status === 200 && !r.serverError) log(`#${index} ${r.model} server_error transient - re-probe clean`);
  }
  if (still.length === 0) return { recovered: true, restarted: false };
  if (a < SERVER_ERROR_RETRY - 1) continue;
  const ok = await rotateTier1Once(index, still.map((r) => r.model));
  if (ok) return { recovered: true, restarted: true };
  for (const r of still) log(`#${index} ${r.model} still server_error after t1 - holding, no tier-2`);
  return { recovered: false, restarted: true };
 }
 return { recovered: false, restarted: false };
}

/** Run `worker` over `items` with bounded concurrency. */
async function runPool(items, limit, worker) {
 const queue = [...items];
 const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
  while (queue.length > 0) {
   const item = queue.shift();
   if (item === undefined) return;
   await worker(item);
  }
 });
 await Promise.all(runners);
}

// ── One pass ────────────────────────────────────────────────────────
async function pass() {
 log(`probing ${COUNT} relay(s) x ${PROBE_MODELS.length} model(s) via ${RELAY_HOST}:${BASE_PORT + 1}..${BASE_PORT + COUNT}`);
 const perRelay = await Promise.all(
  Array.from({ length: COUNT }, (_, k) => probeRelay(k + 1)),
 );
 const results = perRelay.flat();

 // Latency ranking on the speed model (200s only) — same prompt, same
 // minute, so spread here is egress quality, not upstream mood.
 // Envelope-200s carrying server_error are failures, not timings.
 const speedRows = results
  .filter((r) => r.model === SPEED_MODEL && r.status === 200 && !r.serverError)
  .sort((a, b) => a.ms - b.ms);
 if (speedRows.length) {
  log(`speed ${SPEED_MODEL}: ` + speedRows.map((r) => `#${r.index} ${r.ms}ms`).join(" "));
 }

 // Global-quota guard: a model 429ing on a majority of relays is upstream
 // model quota — no egress rotation can fix it, so skip it for rotation
 // decisions this pass instead of churning every WARP client.
 const throttledCount = new Map(); // model -> relays answering 429
 for (const r of results) {
  if (r.status === 429) throttledCount.set(r.model, (throttledCount.get(r.model) ?? 0) + 1);
 }
 const quotaCapped = new Set(
  [...throttledCount.entries()].filter(([, n]) => n >= GLOBAL_QUOTA_GUARD).map(([m]) => m),
 );
 for (const m of quotaCapped) {
  log(`${m} throttled on ${throttledCount.get(m)}/${COUNT} relays — upstream quota, skipping rotation for it this pass`);
 }
 const rotatable = PROBE_MODELS.filter((m) => !quotaCapped.has(m));

 // server_error incident guard: a model failing with server_error on nearly
 // every relay is an upstream incident — no egress rotation can fix it, so
 // skip rotation for it this pass (same spirit as GLOBAL_QUOTA_GUARD).
 const serverErrCount = new Map(); // model -> relays with server_error
 for (const r of results) {
  if (r.serverError) serverErrCount.set(r.model, (serverErrCount.get(r.model) ?? 0) + 1);
 }
 const serverErrCapped = new Set(
  [...serverErrCount.entries()].filter(([, n]) => n >= SERVER_ERROR_GUARD).map(([m]) => m),
 );
 for (const m of serverErrCapped) {
  log(`${m} server_error on ${serverErrCount.get(m)}/${COUNT} relays - upstream incident, skipping rotation`);
 }

 const hot = new Map(); // index -> 429ed rotatable models
 const cappedOnly = [];
 const troubled = [];
 const serverErr = new Map(); // index -> server_error results (rotatable only)
 const badIndexes = new Set();
 for (const r of results) {
  if (r.status === 200 && !r.serverError) continue;
  badIndexes.add(r.index);
  if (r.serverError) {
   if (serverErrCapped.has(r.model)) continue; // counted in the guard line above
   const evt = r.status === 200
    ? (/response\.failed/i.test(r.detail) ? "response.failed" : /failed to generate/i.test(r.detail) ? "failed to generate" : "server_error")
    : null;
   if (evt) log(`#${r.index} ${r.model} server_error in 200 envelope (SSE ${evt})`);
   else log(`#${r.index} ${r.model} server_error HTTP ${r.status}`);
   if (!serverErr.has(r.index)) serverErr.set(r.index, []);
   serverErr.get(r.index).push(r);
  } else if (r.status === 429) {
   if (quotaCapped.has(r.model)) continue; // counted in the guard line above
   if (!hot.has(r.index)) hot.set(r.index, []);
   hot.get(r.index).push(r.model);
  } else troubled.push(r);
 }
 for (const i of badIndexes) {
  if (!hot.has(i) && !serverErr.has(i) && !troubled.some((r) => r.index === i)) cappedOnly.push(i);
 }
 if (cappedOnly.length) log(`throttled only on quota-capped models (left alone): ${cappedOnly.map((i) => `#${i}`).join(" ")}`);

 // Speed rotation: clean but slow on SPEED_MODEL, and only when a fast
 // sibling proves the slowness is egress-side. Whole pool slow = upstream.
 const slow = new Map(); // index -> ms
 if (SLOW_THRESHOLD_MS > 0 && speedRows.length) {
  const fastest = speedRows[0].ms;
  if (fastest <= SLOW_THRESHOLD_MS) {
   for (const r of speedRows) {
    if (r.ms > SLOW_THRESHOLD_MS && !hot.has(r.index)) slow.set(r.index, r.ms);
   }
   if (slow.size) log(`slow (>${SLOW_THRESHOLD_MS}ms, fastest #${speedRows[0].index} ${fastest}ms): ` + [...slow.entries()].map(([i, ms]) => `#${i} ${ms}ms`).join(" "));
  } else {
   log(`whole pool slow on ${SPEED_MODEL} (fastest ${fastest}ms) — upstream, no speed rotation`);
  }
 }

 // Every relay with any non-200 model counts against the clean tally —
 // including relays whose only failure is a quota-capped model, which the
 // rotation path deliberately leaves alone. Reporting them as clean is how a
 // fully throttled pool used to log `clean N/N` and exit 0.
 const badRelays = new Set([
  ...hot.keys(),
  ...serverErr.keys(),
  ...troubled.map((r) => r.index),
  ...cappedOnly,
 ]);
 const hotDesc = [...hot.entries()].map(([i, ms]) => `#${i}(${ms.join(",")})`).join(" ");
 const serverErrDesc = [...serverErr.entries()].map(([i, rs]) => `#${i}(${rs.map((r) => r.model).join(",")})`).join(" ");
 const cappedDesc = cappedOnly.length ? ` | quota-capped: ${cappedOnly.map((i) => `#${i}`).join(" ")}` : "";
 log(`clean ${COUNT - badRelays.size}/${COUNT} relay(s)` + (hot.size ? ` | throttled: ${hotDesc}` : "") + (serverErr.size ? ` | server_error: ${serverErrDesc}` : "") + cappedDesc);
 for (const r of troubled) log(`#${r.index} ${r.model} unexpected HTTP ${r.status || "unreachable"} — ${r.detail}`);

 // 502 means the relay app is up but its upstream path failed — a dead WARP
 // tunnel that `restart: always` will never notice. Give it one t1 attempt.
 // Status 0 (host cannot reach the relay) stays operator-only.
 const badGateway = new Map();
 for (const r of troubled) {
  if (r.status !== 502) continue;
  if (!badGateway.has(r.index)) badGateway.set(r.index, []);
  badGateway.get(r.index).push(r.model);
 }

 if (hot.size === 0 && slow.size === 0 && serverErr.size === 0 && badGateway.size === 0) {
  if (cappedOnly.length) log(`pool is not cold: throttled on quota-capped model(s) only — nothing rotatable this pass`);
  else log("pool is cold");
  return troubled.length === 0 && cappedOnly.length === 0;
 }

 // server_error phase runs before the 429 path: cheap same-egress re-probes
 // filter transients with zero restarts; sticky relays get exactly one t1.
 const serverHold = [];
 if (serverErr.size) {
  await runPool([...serverErr.keys()], ROTATE_CONCURRENCY, async (index) => {
   const models = serverErr.get(index).map((r) => r.model);
   const { recovered, restarted } = await handleServerError(index, models);
   // Max 1 restart per relay per pass: a server_error t1 already spent this
   // relay's churn budget, so drop it from the 429 path (rechecked next pass).
   if (restarted) hot.delete(index);
   if (!recovered) serverHold.push(index);
  });
 }

 let allRecovered = true;
 let troubledLeft = [...troubled];

 if (badGateway.size) {
  await runPool([...badGateway.keys()], ROTATE_CONCURRENCY, async (index) => {
   const badGatewayModels = badGateway.get(index);
   const recovered = await rotateTier1Once(index, badGatewayModels);
   // Only the models this rotation re-probed are proven clean. Dropping the
   // whole relay index would hide a sibling model's 500/transport failure and
   // let the pass exit 0 on a still-broken relay.
   if (recovered) {
    troubledLeft = troubledLeft.filter((r) => !(r.index === index && badGatewayModels.includes(r.model)));
   } else {
    allRecovered = false;
   }
  });
 }

 await runPool([...hot.keys()], ROTATE_CONCURRENCY, async (index) => {
  const recovered = await rotateUntilClean(index, rotatable);
  if (!recovered) allRecovered = false;
 });
 const speedSpec = { model: SPEED_MODEL, threshold: SLOW_THRESHOLD_MS };
 await runPool([...slow.keys()], ROTATE_CONCURRENCY, async (index) => {
  const recovered = await rotateUntilClean(index, rotatable, speedSpec);
  if (!recovered) allRecovered = false;
 });
 return allRecovered && troubledLeft.length === 0 && serverHold.length === 0 && cappedOnly.length === 0;
}

// ── Entry point ─────────────────────────────────────────────────────
if (LOOP) {
 log(`loop mode: pass every ${INTERVAL_S}s (Ctrl-C to stop)`);
 for (; ;) {
  const started = Date.now();
  try {
   await pass();
  } catch (e) {
   log(`pass failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  // Fixed deadline: a slow pass must not push every later pass.
  await new Promise((r) => setTimeout(r, Math.max(0, started + INTERVAL_S * 1_000 - Date.now())));
 }
} else {
 const ok = await pass();
 // exitCode lets stdout drain (process.exit() can drop the final lines).
 process.exitCode = ok ? 0 : 1;
}
