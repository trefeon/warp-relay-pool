#!/usr/bin/env node
/**
 * keep-cold.mjs — demand-driven MicroWARP egress prober/rotator.
 *
 * Every relay in this pool reaches the upstream through its own Cloudflare WARP
 * client container, so each has its own egress IPv6 address. Cloudflare
 * recycles those addresses across public WARP users, which means a container
 * can come up already throttled by the upstream provider (HTTP 429) even
 * though the relay itself is perfectly healthy. Throttling is PER MODEL per
 * egress IP: warp-1 can serve one model 200 while 429ing another on the same
 * address (observed 2026-10-02), so one model is never enough to declare a
 * relay clean.
 *
 * Demand-driven probing
 * ---------------------
 * The first pass (RELAY_STATE_FILE holds no relay entries) is a full baseline
 * sweep of every relay 1..COUNT x PROBE_MODELS: only a 200/429 answers tell us
 * what the pool is doing. Every later pass probes only
 *   - relays a restart is still waiting to verify (pendingVerify, once the
 *     EGRESS_SETTLE_S window after that restart has elapsed),
 *   - relays still marked dirty whose probeAfter timer expired,
 *   - a round-robin audit sample of PROBE_AUDIT_SAMPLE clean relays, so a
 *     silent per-egress throttle is still discovered,
 *   - relays named by live traffic signals (LIVE_SIGNALS=1, written by
 *     server.mjs), which are rotated without any inference probe at all.
 * On a healthy 20-relay pool that is PROBE_AUDIT_SAMPLE requests per pass
 * instead of COUNT * |PROBE_MODELS| (60 before this change) — the disk-I/O
 * storm the old full sweep caused on the 5400 rpm host is gone.
 *
 * One restart per cooldown
 * ------------------------
 * A relay is restarted at most once per RELAY_COOLDOWN_S, at most
 * RELAY_MAX_ROTATIONS_PER_HOUR times per rolling hour, never inside the
 * EGRESS_SETTLE_S window that follows its previous restart, and only when its
 * cooldown has expired. Repeated failing batches multiply the cooldown
 * (RELAY_BACKOFF_BASE_S * 2^(n-1), capped at RELAY_BACKOFF_MAX_S), so a relay
 * that stays throttled backs off instead of churning. There is NO post-restart
 * probe, NO readiness wait and NO retry loop: the restart is recorded and a
 * later pass verifies it once the settle window has passed. All docker
 * restarts (tier-1, tier-2, 502 and server_error) share one serialisation
 * chain that starts them at least ROTATE_SPACING_MS apart.
 *
 * A 429 carrying a numeric `retry-after` <= 120 s never restarts: it sets the
 * next probe time instead. Tier-2 (wipe /etc/wireguard/wg0.conf + restart,
 * one Cloudflare registration) is used only for pure 429 batches, at most once
 * per relay per TIER2_MIN_INTERVAL_S; server_error and 502 rotations are
 * tier-1 only. Nodes without wg0.conf abort the re-key and fall back to a
 * plain restart, leaving their registration untouched.
 *
 * Guardrails
 * ----------
 * A model throttled on GLOBAL_QUOTA_GUARD relays is upstream model quota: it is
 * skipped for rotation this pass, and relays failing only on such models are
 * reported as quota-capped and never counted clean. The same guard reads the
 * 429 history kept in the state file (900 s window), so quota is recognised
 * across passes. A model failing with server_error on SERVER_ERROR_GUARD relays
 * is an upstream incident: rotation is skipped for it this pass.
 *
 * Status 0 (the host cannot reach the relay) and any other unexpected status
 * (403/500/503/...) are troubled: no restart, the relay waits
 * RELAY_COOLDOWN_S before the next probe. A server_error keeps its same-egress
 * re-probe filter (SERVER_ERROR_RETRY x SERVER_ERROR_REPROBE_MS) before the
 * gate; a server_error that clears on re-probe is clean.
 *
 * Speed ranking is logged per pass (`speed <model>: #N Nms …`) but rotation on
 * speed is DISABLED by default (SLOW_THRESHOLD_MS=0): the 2026-10-02 trial
 * falsified single-sample rank as an egress signal. With a threshold set, a
 * slow relay goes through the same gate/restart path, tier-1 only.
 *
 * The public relay URLs never change: the `*.trycloudflare.com` tunnels and the
 * relay application are different containers and are never touched here. Only
 * `warp-relay-warp-N` is ever restarted, so every URL already configured in the
 * client pool keeps working through the rotation.
 *
 * State (JSON, ms epochs) and signals are optimisations: a missing, corrupt or
 * unwritable state file (or signal file) degrades to a full sweep and a pass
 * that still runs, never a failed pass.
 *
 * Exit codes
 *  0  every relay is known clean at the end of the pass: nothing dirty, no
 *     quota-capped relay left failing, nothing troubled, no rotation awaiting
 *     verification
 *  1  at least one relay is dirty / held / throttled / awaiting verification
 *  2  bad usage or invalid environment
 *
 * Usage:
 *   node keep-cold.mjs --once                 # single pass
 *   node keep-cold.mjs --loop                 # pass every INTERVAL_S seconds
 *   INTERVAL_S=600 node keep-cold.mjs --loop
 *
 * Environment (new in this revision):
 *   RELAY_STATE_FILE    per-relay state (default .keep-cold/state.json)
 *   RELAY_COOLDOWN_S    minimum gap between rotations of one relay (default 600)
 *   RELAY_BACKOFF_BASE_S / RELAY_BACKOFF_MAX_S  exponential cooldown on repeated
 *                       failure, seconds (default 300 / 3600)
 *   RELAY_MAX_ROTATIONS_PER_HOUR  hard hourly budget per relay (default 2)
 *   PROBE_AUDIT_SAMPLE  clean relays probed per pass (default 2, min 0, max COUNT)
 *   EGRESS_SETTLE_S     post-restart quiet window before probing again (default 150)
 *   ROTATE_SPACING_MS   serialisation gap between restart operations (default 4000)
 *   LIVE_SIGNALS        1 = consume LIVE_SIGNAL_FILE (default 0)
 *   LIVE_SIGNAL_FILE    live 429/recovery records from server.mjs
 *                       (default .keep-cold/signals.json)
 *   PROBE_CONCURRENCY   relays probed in parallel (default 4, 1..64)
 *   KEEP_COLD_CLOCK_SKEW_S  test aid: now() = Date.now() + skew*1000 (default 0)
 *   DOCKER_BIN          docker binary (default docker)
 *   DOCKER_PREFIX_ARGS  space-separated args inserted before every docker
 *                       argument list (default empty)
 *
 * Environment (unchanged, still honoured):
 *   RELAY_HOST          relay app bridge address      (default 10.244.0.100)
 *   BASE_PORT           first relay port              (default 3000)
 *   COUNT               number of relays              (default 10)
 *   PROBE_TARGET        upstream the probes go through (default
 *                       https://api.kilo.ai — the lane clients actually use)
 *   PROBE_CHAT_PATH     chat wire path under PROBE_TARGET (default
 *                       /api/gateway/chat/completions)
 *   PROBE_RESPONSES_PATH  responses wire path under PROBE_TARGET (default
 *                       /api/gateway/responses)
 *   PROBE_MODELS        comma-separated models to probe (default three
 *                       families so per-model throttles stay distinguishable)
 *   PROBE_MODEL         legacy single-model override (used only when
 *                       PROBE_MODELS is unset)
 *   RESPONSES_MODELS    comma-separated models probed via PROBE_RESPONSES_PATH
 *   GLOBAL_QUOTA_GUARD  relays-throttled threshold at which a model counts as
 *                       upstream quota (default max(8, COUNT-1), capped at COUNT)
 *   SERVER_ERROR_RETRY  same-egress re-probes before a server_error rotation
 *                       (default 1)
 *   SERVER_ERROR_REPROBE_MS  delay before each re-probe (default 5000)
 *   SERVER_ERROR_GUARD  relays-with-server_error threshold at which a model
 *                       counts as upstream incident (default 9, capped at COUNT)
 *   SPEED_MODEL         model whose latency decides slow rotation
 *   SLOW_THRESHOLD_MS   200-response slower than this is rotated for speed
 *                       (default 0 = disabled)
 *   CONTAINER_PREFIX    docker container prefix       (default warp-relay-warp-)
 *   PROBE_TIMEOUT_MS    per-probe request timeout     (default 30000)
 *   TIER2_MIN_INTERVAL_S  minimum seconds between tier-2 re-keys for one relay,
 *                       persisted in TIER2_STATE_FILE (default 3600)
 *   ROTATE_CONCURRENCY  parallel rotation workers     (default 1)
 *   INTERVAL_S          seconds between loop passes   (default 300)
 *   KEEP_COLD_LOG       append the log to this file   (default stdout only)
 *   KEEP_COLD_LOG_MAX_BYTES  rotate above this size    (default 2 MiB)
 *   KEEP_COLD_LOG_KEEP_BYTES keep this much on rotate   (default 200 KiB)
 *
 * Environment (accepted and ignored — kept so installed unit files stay valid):
 *   READY_TIMEOUT_MS, SOCKS_HOST, SOCKS_PORT_BASE, MAX_ROTATIONS,
 *   SLOW_MAX_ROTATIONS. Nothing here waits for readiness or verifies a rotation
 *   inline any more; those knobs only guarded the old retry loop.
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

/** Validate a probe wire path (rooted, no scheme). */
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

/**
 * Filesystem path: relative (the repo-relative defaults) or absolute (unit
 * files, tests). Only blank values are rejected.
 */
function envFile(name, dflt) {
 const value = process.env[name] ?? dflt;
 if (value.trim() === "") {
  console.error(`keep-cold: ${name} is set but blank`);
  process.exit(2);
 }
 return value;
}

const RELAY_HOST = process.env.RELAY_HOST ?? "10.244.0.100";
const BASE_PORT = envInt("BASE_PORT", 3000, { max: 65535 });
const COUNT = envInt("COUNT", 10, { min: 1, max: 64 });
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
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX ?? "warp-relay-warp-";
const PROBE_TIMEOUT_MS = envInt("PROBE_TIMEOUT_MS", 30_000, { min: 1 });
const ROTATE_CONCURRENCY = envInt("ROTATE_CONCURRENCY", 1, { min: 1, max: 64 });
const SERVER_ERROR_RETRY = envInt("SERVER_ERROR_RETRY", 1);
const SERVER_ERROR_REPROBE_MS = envInt("SERVER_ERROR_REPROBE_MS", 5_000);
const SERVER_ERROR_GUARD = Math.min(envInt("SERVER_ERROR_GUARD", 9, { min: 1 }), COUNT);
const INTERVAL_S = envInt("INTERVAL_S", 300, { min: 1 });
const TIER2_MIN_INTERVAL_S = envInt("TIER2_MIN_INTERVAL_S", 3600);

// ── Demand-driven scheduling knobs ──────────────────────────────────
const RELAY_STATE_FILE = envFile("RELAY_STATE_FILE", ".keep-cold/state.json");
const LIVE_SIGNAL_FILE = envFile("LIVE_SIGNAL_FILE", ".keep-cold/signals.json");
const TIER2_STATE_FILE = envFile("TIER2_STATE_FILE", ".keep-cold/tier2-state.json");
const RELAY_COOLDOWN_S = envInt("RELAY_COOLDOWN_S", 600);
const RELAY_BACKOFF_BASE_S = envInt("RELAY_BACKOFF_BASE_S", 300, { min: 1 });
const RELAY_BACKOFF_MAX_S = envInt("RELAY_BACKOFF_MAX_S", 3600, { min: 1 });
const RELAY_MAX_ROTATIONS_PER_HOUR = envInt("RELAY_MAX_ROTATIONS_PER_HOUR", 2, { min: 1 });
const PROBE_AUDIT_SAMPLE = envInt("PROBE_AUDIT_SAMPLE", 2, { min: 0, max: COUNT });
const EGRESS_SETTLE_S = envInt("EGRESS_SETTLE_S", 150);
const ROTATE_SPACING_MS = envInt("ROTATE_SPACING_MS", 4000);
const LIVE_SIGNALS = envInt("LIVE_SIGNALS", 0, { min: 0, max: 1 }) === 1;
const PROBE_CONCURRENCY = envInt("PROBE_CONCURRENCY", 4, { min: 1, max: 64 });
const CLOCK_SKEW_S = envInt("KEEP_COLD_CLOCK_SKEW_S", 0, { min: -Number.MAX_SAFE_INTEGER });
const DOCKER_BIN = envFile("DOCKER_BIN", "docker");
const DOCKER_PREFIX_ARGS = (process.env.DOCKER_PREFIX_ARGS ?? "").split(/\s+/).filter(Boolean);

// Accepted for backwards compatibility with installed unit files, then
// ignored: this controller no longer waits for readiness or verifies a
// rotation inline. Parsed (not just read) so a broken unit file still fails
// fast instead of silently changing behaviour.
envInt("READY_TIMEOUT_MS", 180_000, { min: 1 });
envInt("SOCKS_PORT_BASE", 10800, { min: 1, max: 65535 });
envInt("MAX_ROTATIONS", 4, { min: 1 });
envInt("SLOW_MAX_ROTATIONS", 2);

/**
 * Every state timestamp, comparison and log-visible decision runs on now().
 * KEEP_COLD_CLOCK_SKEW_S exists so tests can walk a scenario forward in time
 * without touching the state file.
 */
function now() {
 return Date.now() + CLOCK_SKEW_S * 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short single-line reason for state-file diagnostics. */
function shortReason(e) {
 return String(e?.message ?? e ?? "unknown").replace(/\s+/g, " ").trim().slice(0, 80);
}

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
  // Marks keep-cold's own traffic: the relay app's live-signal writer must not
  // turn a probe's 429 into a "live traffic" signal (it would feed the next
  // pass a throttle the probe itself just created). Stripped before upstream.
  "x-keep-cold-probe": "1",
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

// ── Per-relay state ─────────────────────────────────────────────────
// State is an optimisation: every read/write path degrades to the baseline
// full sweep instead of failing the pass.
let passBrokenStateLogged = false;
let passWriteFailureLogged = false;

function logBrokenStateOnce(reason) {
 if (passBrokenStateLogged) return;
 passBrokenStateLogged = true;
 log(`state file unusable (${reason}) — full sweep`);
}

function logWriteFailureOnce(reason) {
 if (passWriteFailureLogged) return;
 passWriteFailureLogged = true;
 log(`state file write failed (${reason}) — continuing`);
}

function emptyState() {
 return { version: 1, auditCursor: 0, relays: {} };
}

/** Read + shape-check the state file. Throws on anything unusable. */
function readStateFile() {
 const raw = fs.readFileSync(RELAY_STATE_FILE, "utf8");
 const parsed = JSON.parse(raw);
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
 const relays = parsed.relays && typeof parsed.relays === "object" && !Array.isArray(parsed.relays)
  ? parsed.relays
  : {};
 const auditCursor = Number.isFinite(parsed.auditCursor) ? parsed.auditCursor : 0;
 return { version: 1, auditCursor, relays };
}

function loadState() {
 try {
  return readStateFile();
 } catch (e) {
  // ENOENT is the documented first run, not a broken file.
  if (e?.code !== "ENOENT") logBrokenStateOnce(e?.code ?? shortReason(e));
  return emptyState();
 }
}

function num(v) {
 return Number.isFinite(v) ? v : 0;
}

/** One relay's state with every field defaulted. */
function relayEntry(state, index) {
 const raw = state.relays?.[String(index)];
 const e = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
 const last429 = e.last429 && typeof e.last429 === "object" ? e.last429 : {};
 return {
  lastProbe: num(e.lastProbe),
  lastClean: num(e.lastClean),
  lastRotate: num(e.lastRotate),
  consecutiveFailures: num(e.consecutiveFailures),
  cooldownUntil: num(e.cooldownUntil),
  probeAfter: num(e.probeAfter),
  dirty: e.dirty === true,
  pendingVerify: e.pendingVerify === true,
  last429: { model: typeof last429.model === "string" ? last429.model : "", ts: num(last429.ts) },
  rotations: Array.isArray(e.rotations) ? e.rotations.map(num).filter((t) => t > 0) : [],
 };
}

/** Restart stamps are kept for the rolling-hour budget only. */
function pruneRotations(rotations, at) {
 const cutoff = at - 3_600_000;
 return rotations.filter((ts) => ts > cutoff).slice(-64);
}

/**
 * Merge-on-write: re-read the file, patch one relay (or the audit cursor), then
 * tmp+rename. Concurrent writers therefore cannot erase each other's stamps.
 */
function writeState(mutator, suffix) {
 try {
  fs.mkdirSync(path.dirname(RELAY_STATE_FILE), { recursive: true });
  let fresh;
  try {
   fresh = readStateFile();
  } catch {
   fresh = emptyState();
  }
  mutator(fresh);
  fresh.version = 1;
  const tmp = `${RELAY_STATE_FILE}.${process.pid}.${suffix}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fresh));
  fs.renameSync(tmp, RELAY_STATE_FILE);
 } catch (e) {
  logWriteFailureOnce(shortReason(e));
 }
}

/** Patch one relay in memory and on disk; returns the merged entry. */
function patchRelay(state, index, patch) {
 const merged = { ...relayEntry(state, index), ...patch };
 merged.rotations = pruneRotations(merged.rotations, now());
 state.relays[String(index)] = merged;
 writeState((fresh) => {
  const next = { ...relayEntry(fresh, index), ...patch };
  next.rotations = pruneRotations(next.rotations, now());
  fresh.relays[String(index)] = next;
 }, String(index));
 return merged;
}

function saveAuditCursor(cursor) {
 writeState((fresh) => {
  fresh.auditCursor = cursor;
 }, "audit");
}

// ── Live signals ────────────────────────────────────────────────────
/**
 * Read and consume LIVE_SIGNAL_FILE: server.mjs appends one record per state
 * change, this controller rewrites the file as {"signals":[]} so no record is
 * processed twice. Missing/corrupt file = no signals, no log line.
 */
function readSignals() {
 let raw;
 try {
  raw = fs.readFileSync(LIVE_SIGNAL_FILE, "utf8");
 } catch {
  return null;
 }
 let parsed;
 try {
  parsed = JSON.parse(raw);
 } catch {
  return null;
 }
 const list = Array.isArray(parsed?.signals) ? parsed.signals : null;
 if (!list) return null;
 try {
  fs.mkdirSync(path.dirname(LIVE_SIGNAL_FILE), { recursive: true });
  const tmp = `${LIVE_SIGNAL_FILE}.${process.pid}.signals.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ signals: [] }));
  fs.renameSync(tmp, LIVE_SIGNAL_FILE);
 } catch {
  // Consuming is best effort; a leftover record is re-read next pass.
 }
 return list.filter((s) => s && Number.isInteger(s.relay) && s.relay >= 1 && s.relay <= COUNT);
}

// ── Docker helpers ──────────────────────────────────────────────────
function containerName(index) {
 return `${CONTAINER_PREFIX}${index}`;
}

async function docker(args, timeout = 30_000) {
 const { stdout } = await execFileAsync(DOCKER_BIN, [...DOCKER_PREFIX_ARGS, ...args], {
  encoding: "utf8",
  timeout,
  maxBuffer: 4 * 1024 * 1024,
 });
 return stdout;
}

// ONE serialisation chain for every restart operation (tier-1, tier-2,
// 502/server_error): consecutive operations start at least ROTATE_SPACING_MS
// apart, no matter which phase queued them.
let restartChain = Promise.resolve();
let lastRestartAt = 0;

function enqueueRestart(work) {
 const next = restartChain.then(async () => {
  if (lastRestartAt > 0) {
   const gap = ROTATE_SPACING_MS - (now() - lastRestartAt);
   if (gap > 0) await sleep(gap);
  }
  lastRestartAt = now();
  return work();
 });
 // A failed operation must not poison the chain for the next relay.
 restartChain = next.then(() => { }, () => { });
 return next;
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
 * Envelope-shape server_error hides inside 200 streams, which a
 * cancel-unread probe would count as clean.
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
  // Numeric Retry-After only; an HTTP-date header is left to the gate.
  const raRaw = res.status === 429 ? res.headers.get("retry-after") : null;
  const retryAfter = raRaw && /^\d+$/.test(raRaw.trim()) ? Number(raRaw.trim()) : null;
  return { index, model, status: res.status, serverError: isServerError(res.status, detail), detail, retryAfter, ms: Date.now() - t0 };
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

// Tier-2 spends a Cloudflare registration. One per relay per TIER2_MIN_INTERVAL_S
// is the budget; the state file keeps a stuck relay from re-spending it on
// every timer tick.
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

function tier2Allowed(index, tier2State = loadTier2State()) {
 if (TIER2_MIN_INTERVAL_S === 0) return true;
 return now() - Number(tier2State[index] ?? 0) >= TIER2_MIN_INTERVAL_S * 1000;
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

// ── Rotation budget ─────────────────────────────────────────────────
/** Exponential cooldown for the n-th consecutive failing batch. */
function effectiveCooldown(n) {
 const base = RELAY_BACKOFF_BASE_S * 1000 * 2 ** Math.max(0, n - 1);
 return Math.max(RELAY_COOLDOWN_S * 1000, Math.min(base, RELAY_BACKOFF_MAX_S * 1000));
}

function rotationsWithinHour(entry, at) {
 return entry.rotations.filter((ts) => at - ts < 3_600_000);
}

/**
 * The rotation gate: cooldown, minimum gap between rotations, settle window,
 * rolling-hour budget. `allowed: false` carries the exact reason the pass logs.
 */
function gate(entry, at) {
 const cooldown = entry.cooldownUntil - at;
 if (cooldown > 0) return { allowed: false, reason: `cooldown ${Math.ceil(cooldown / 1000)}s remaining` };
 const gap = RELAY_COOLDOWN_S * 1000 - (at - entry.lastRotate);
 if (gap > 0) return { allowed: false, reason: `cooldown ${Math.ceil(gap / 1000)}s remaining` };
 if (at < entry.lastRotate + EGRESS_SETTLE_S * 1000) return { allowed: false, reason: "settle window" };
 const recent = rotationsWithinHour(entry, at);
 if (recent.length >= RELAY_MAX_ROTATIONS_PER_HOUR) {
  return { allowed: false, reason: `hourly budget ${recent.length}/${RELAY_MAX_ROTATIONS_PER_HOUR}` };
 }
 return { allowed: true };
}

/**
 * Perform one rotation through the spacing chain, then record it. There is no
 * readiness wait and no verification probe here: the settle window plus
 * pendingVerify make a later pass the verifier.
 */
async function runRotation(job, state, dirty) {
 const container = containerName(job.index);
 const at = await enqueueRestart(async () => {
  const started = now();
  if (job.tier2) {
   let rekeyable = true;
   try {
    await docker(["exec", container, "test", "-f", "/etc/wireguard/wg0.conf"], 30_000);
   } catch {
    rekeyable = false;
   }
   if (!rekeyable) {
    log(`#${job.index} tier-2 aborted: no /etc/wireguard/wg0.conf — leaving registration untouched`);
    log(`#${job.index} rotating egress (t1) — restarting ${container}`);
    try {
     await docker(["restart", container], 60_000);
    } catch (e) {
     log(`#${job.index} restart failed: ${shortReason(e)}`);
    }
    return started;
   }
   log(`#${job.index} rotating egress (t2) — re-keying ${container}`);
   try {
    await docker(["exec", container, "rm", "-f", "/etc/wireguard/wg0.conf"], 30_000);
    await docker(["restart", container], 60_000);
   } catch (e) {
    log(`#${job.index} restart failed: ${shortReason(e)}`);
   }
   saveTier2State(job.index, started);
   return started;
  }
  log(`#${job.index} rotating egress (t1) — restarting ${container}`);
  try {
   await docker(["restart", container], 60_000);
  } catch (e) {
   log(`#${job.index} restart failed: ${shortReason(e)}`);
  }
  return started;
 });
 const entry = relayEntry(state, job.index);
 const patch = {
  lastRotate: at,
  dirty: true,
  pendingVerify: job.verify !== false,
  lastProbe: at,
  probeAfter: at + EGRESS_SETTLE_S * 1000,
  cooldownUntil: at + effectiveCooldown(job.n),
  rotations: [...entry.rotations, at],
  consecutiveFailures: job.n,
 };
 if (job.model) patch.last429 = { model: job.model, ts: at };
 patchRelay(state, job.index, patch);
 dirty.add(job.index);
}

// ── Suspect selection ───────────────────────────────────────────────
/**
 * Demand-driven suspect list: pendingVerify relays past their settle window,
 * dirty relays whose probeAfter expired, plus one round-robin audit sample of
 * clean relays. Baseline (no state yet) selects everything.
 */
function selectSuspects(state, { baseline, excluded }) {
 const at = now();
 const selected = new Set();
 const audit = [];
 if (baseline) {
  // A live signal already names a relay: probing it in the same pass would
  // waste a request and could race the restart it is about to get.
  for (let i = 1; i <= COUNT; i++) if (!excluded.has(i)) selected.add(i);
  return { selected, audit };
 }
 for (let i = 1; i <= COUNT; i++) {
  if (excluded.has(i)) continue;
  const e = relayEntry(state, i);
  if (e.pendingVerify && at >= e.lastRotate + EGRESS_SETTLE_S * 1000) {
   selected.add(i);
   continue;
  }
  if (e.dirty && at >= e.probeAfter) selected.add(i);
 }
 const cursor = Number.isInteger(state.auditCursor) ? state.auditCursor : 0;
 let nextCursor = cursor;
 for (let k = 1; k <= COUNT && audit.length < PROBE_AUDIT_SAMPLE; k++) {
  const index = ((cursor + k - 1) % COUNT) + 1;
  if (selected.has(index) || excluded.has(index)) continue;
  const e = relayEntry(state, index);
  if (e.dirty || e.pendingVerify) continue;
  if (at < e.lastRotate + EGRESS_SETTLE_S * 1000) continue;
  audit.push(index);
  selected.add(index);
  nextCursor = index;
 }
 if (audit.length) saveAuditCursor(nextCursor);
 return { selected, audit };
}

// ── Result handling ─────────────────────────────────────────────────
function cleanPatch() {
 return {
  lastProbe: now(),
  lastClean: now(),
  dirty: false,
  pendingVerify: false,
  consecutiveFailures: 0,
  cooldownUntil: 0,
  probeAfter: 0,
  // A relay that answers 200 on every probed model is no longer evidence for
  // the pool-wide quota history; leaving the stamp would cap a model for 900 s
  // after the pool recovered.
  last429: { model: "", ts: 0 },
 };
}

function markClean(ctx, index) {
 patchRelay(ctx.state, index, cleanPatch());
 ctx.dirty.delete(index);
}

/** Same-egress transient filter for server_error results, before the gate. */
async function reProbeServerErrors(index, failed) {
 let left = failed;
 for (let round = 0; round < SERVER_ERROR_RETRY && left.length > 0; round++) {
  if (SERVER_ERROR_REPROBE_MS > 0) await sleep(SERVER_ERROR_REPROBE_MS);
  const next = [];
  for (const r of left) {
   const again = await probe(index, r.model);
   if (again.status === 200 && !again.serverError) {
    log(`#${index} ${r.model} server_error transient - re-probe clean`);
   } else {
    next.push(again);
   }
  }
  left = next;
 }
 return left;
}

/** Classify one relay's probe batch: patch state, or queue a rotation. */
async function classifyRelay(index, results, ctx) {
 const at = now();
 const failing = results.filter((r) => r.status !== 200 || r.serverError);
 if (failing.length === 0) {
  markClean(ctx, index);
  return;
 }

 const capped = [];
 const srvErr = [];
 const hot = [];
 const gateway = [];
 const other = [];
 for (const r of failing) {
  if (r.serverError) {
   if (ctx.serverErrCapped.has(r.model)) capped.push(r);
   else srvErr.push(r);
   continue;
  }
  if (r.status === 429) {
   if (ctx.quotaCapped.has(r.model)) capped.push(r);
   else hot.push(r);
   continue;
  }
  if (r.status === 502) {
   gateway.push(r);
   continue;
  }
  other.push(r);
 }

 const seLeft = srvErr.length ? await reProbeServerErrors(index, srvErr) : [];
 for (const r of seLeft) {
  const evt = r.status === 200
   ? (/response\.failed/i.test(r.detail) ? "response.failed" : /failed to generate/i.test(r.detail) ? "failed to generate" : "server_error")
   : null;
  if (evt) log(`#${index} ${r.model} server_error in 200 envelope (SSE ${evt})`);
  else log(`#${index} ${r.model} server_error HTTP ${r.status}`);
 }
 if (hot.length) ctx.hotRelays.set(index, hot.map((r) => r.model));
 if (seLeft.length) ctx.seRelays.set(index, seLeft.map((r) => r.model));

 const entry = relayEntry(ctx.state, index);
 const n = entry.consecutiveFailures + 1;
 const rotatable = [...seLeft, ...hot, ...gateway];

 if (rotatable.length === 0 && capped.length === 0 && other.length === 0) {
  // Only transient server_errors failed: the re-probe proved them gone.
  markClean(ctx, index);
  return;
 }

 // The host or the relay app is unhealthy: restarting WARP cannot help, so
 // this keeps the "cannot reach the relay" non-rotation path.
 if (other.length) {
  for (const r of other) log(`#${index} ${r.model} unexpected HTTP ${r.status || "unreachable"} — ${r.detail}`);
  ctx.dirty.add(index);
  patchRelay(ctx.state, index, {
   dirty: true,
   lastProbe: at,
   pendingVerify: false,
   probeAfter: at + RELAY_COOLDOWN_S * 1000,
   consecutiveFailures: n,
  });
  return;
 }

 if (rotatable.length === 0) {
  // Failing only on models the guards call upstream quota / incident.
  ctx.cappedOnly.push(index);
  ctx.dirty.add(index);
  patchRelay(ctx.state, index, {
   dirty: true,
   lastProbe: at,
   pendingVerify: false,
   probeAfter: at + RELAY_COOLDOWN_S * 1000,
   consecutiveFailures: n,
  });
  return;
 }

 // Honour Retry-After instead of restarting: schedule the next probe.
 const retryAfter = hot.filter((r) => Number.isFinite(r.retryAfter) && r.retryAfter >= 0 && r.retryAfter <= 120);
 if (retryAfter.length) {
  const waitS = Math.max(...retryAfter.map((r) => r.retryAfter));
  ctx.dirty.add(index);
  patchRelay(ctx.state, index, {
   dirty: true,
   lastProbe: at,
   last429: { model: retryAfter[0].model, ts: at },
   probeAfter: at + waitS * 1000,
   consecutiveFailures: n,
   pendingVerify: false,
  });
  log(`#${index} retry-after ${waitS}s — scheduling, no restart`);
  return;
 }

 const verdict = gate(entry, at);
 if (verdict.allowed) {
  ctx.dirty.add(index);
  // Tier-2 spends a registration: only for pure 429 batches, and only for a
  // relay that has already been restarted at least once.
  const pure429 = hot.length > 0 && seLeft.length === 0 && gateway.length === 0;
  ctx.rotations.push({
   index,
   n,
   tier2: entry.lastRotate > 0 && pure429 && tier2Allowed(index),
   model: hot[0]?.model ?? seLeft[0]?.model ?? gateway[0]?.model ?? null,
  });
  return;
 }

 ctx.dirty.add(index);
 const patch = {
  dirty: true,
  lastProbe: at,
  pendingVerify: false,
  probeAfter: Math.max(entry.cooldownUntil, at + EGRESS_SETTLE_S * 1000),
  consecutiveFailures: n,
 };
 if (hot.length) patch.last429 = { model: hot[0].model, ts: at };
 patchRelay(ctx.state, index, patch);
 log(`#${index} held: ${verdict.reason}`);
}

/** A live 429 signal: same gate, no probe. */
function classifySignal(index, model, ctx) {
 const at = now();
 const entry = relayEntry(ctx.state, index);
 const n = entry.consecutiveFailures + 1;
 if (model) ctx.hotRelays.set(index, [model]);
 // A model the guards call upstream quota/incident cannot be fixed by an
 // egress change: touching every signalled relay would be the exact churn
 // this scheduler exists to prevent.
 if (model && (ctx.quotaCapped.has(model) || ctx.serverErrCapped.has(model))) {
  ctx.cappedOnly.push(index);
  ctx.dirty.add(index);
  patchRelay(ctx.state, index, {
   dirty: true,
   pendingVerify: false,
   probeAfter: at + RELAY_COOLDOWN_S * 1000,
   consecutiveFailures: n,
   last429: { model, ts: at },
  });
  return;
 }
 const verdict = gate(entry, at);
 if (verdict.allowed) {
  ctx.dirty.add(index);
  ctx.rotations.push({
   index,
   n,
   tier2: entry.lastRotate > 0 && tier2Allowed(index),
   model: model || null,
  });
  return;
 }
 ctx.dirty.add(index);
 patchRelay(ctx.state, index, {
  dirty: true,
  pendingVerify: false,
  probeAfter: Math.max(entry.cooldownUntil, at + EGRESS_SETTLE_S * 1000),
  consecutiveFailures: n,
  ...(model ? { last429: { model, ts: at } } : {}),
 });
 log(`#${index} held: ${verdict.reason}`);
}

// ── One pass ────────────────────────────────────────────────────────
function countByModel(results, predicate) {
 const counts = new Map();
 for (const r of results) {
  if (!predicate(r)) continue;
  counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
 }
 return counts;
}

async function pass() {
 passBrokenStateLogged = false;
 passWriteFailureLogged = false;

 const state = loadState();
 const baseline = Object.keys(state.relays).length === 0;
 const dirty = new Set();
 for (let i = 1; i <= COUNT; i++) if (relayEntry(state, i).dirty) dirty.add(i);

 // ── live signals (phase 2 input, off by default) ──
 const signalHot = new Map();
 if (LIVE_SIGNALS) {
  const signals = readSignals();
  if (signals) {
   for (const sig of signals) {
    const index = sig.relay;
    const entry = relayEntry(state, index);
    // A record older than the relay's own last restart describes an egress
    // that no longer exists: rotating on it would restart a relay that was
    // already rotated (and possibly re-verified clean) after that 429.
    if (!Number.isFinite(Number(sig.ts)) || Number(sig.ts) <= entry.lastRotate) continue;
    if (Number(sig.status) === 429) {
     const model = typeof sig.model === "string" ? sig.model : "";
     if (!signalHot.has(index)) signalHot.set(index, model);
     // Feed last429 so the quota guard sees live traffic too.
     patchRelay(state, index, { dirty: true, last429: { model, ts: now() } });
     dirty.add(index);
    } else {
     patchRelay(state, index, cleanPatch());
     dirty.delete(index);
    }
   }
  }
 }

 const { selected, audit } = selectSuspects(state, { baseline, excluded: new Set(signalHot.keys()) });
 const suspects = [...selected].sort((a, b) => a - b);
 log(`probing ${suspects.length} of ${COUNT} relay(s) x ${PROBE_MODELS.length} model(s) via ${RELAY_HOST}:${BASE_PORT + 1}..${BASE_PORT + COUNT}${baseline ? " (baseline)" : ""}`);
 if (audit.length) log(`audit sample: ${audit.map((i) => `#${i}`).join(" ")}`);

 const probed = new Map();
 await runPool(suspects, PROBE_CONCURRENCY, async (index) => {
  probed.set(index, await probeRelay(index, PROBE_MODELS));
 });
 const all = [...probed.values()].flat();

 // Latency ranking on the speed model (200s only) — same prompt, same
 // minute, so spread here is egress quality, not upstream mood.
 const speedRows = all
  .filter((r) => r.model === SPEED_MODEL && r.status === 200 && !r.serverError)
  .sort((a, b) => a.ms - b.ms);
 if (speedRows.length) {
  log(`speed ${SPEED_MODEL}: ` + speedRows.map((r) => `#${r.index} ${r.ms}ms`).join(" "));
 }

 // Global-quota guard: observed this pass OR carried in state (900 s window) —
 // a model throttled on a majority of relays is upstream model quota and no
 // egress rotation can fix it.
 const observed429 = countByModel(all, (r) => r.status === 429);
 const observedSe = countByModel(all, (r) => r.serverError);
 const history429 = new Map();
 for (let i = 1; i <= COUNT; i++) {
  const e = relayEntry(state, i);
  if (!e.last429.model) continue;
  if (now() - e.last429.ts > 900_000) continue;
  history429.set(e.last429.model, (history429.get(e.last429.model) ?? 0) + 1);
 }
 const quotaCapped = new Set();
 // No PROBE_MODELS filter: live signals name the client's real models, and a
 // model capped on a majority of relays is upstream quota whichever lane
 // reported it.
 for (const model of new Set([...observed429.keys(), ...history429.keys()])) {
  const seen = observed429.get(model) ?? 0;
  const history = history429.get(model) ?? 0;
  if (seen < GLOBAL_QUOTA_GUARD && history < GLOBAL_QUOTA_GUARD) continue;
  quotaCapped.add(model);
  log(`${model} throttled on ${Math.min(Math.max(seen, history), COUNT)}/${COUNT} relays — upstream quota, skipping rotation for it this pass`);
 }
 const serverErrCapped = new Set();
 for (const [model, n] of observedSe) {
  if (n < SERVER_ERROR_GUARD) continue;
  serverErrCapped.add(model);
  log(`${model} server_error on ${n}/${COUNT} relays - upstream incident, skipping rotation`);
 }

 const ctx = {
  state,
  dirty,
  quotaCapped,
  serverErrCapped,
  rotations: [],
  hotRelays: new Map(),
  seRelays: new Map(),
  cappedOnly: [],
 };
 for (const [index, results] of [...probed.entries()].sort((a, b) => a[0] - b[0])) {
  await classifyRelay(index, results, ctx);
 }

 // Speed rotation stays opt-in: only when a fast sibling proves the slowness
 // is egress-side. Tier-1 only, no verification loop.
 if (SLOW_THRESHOLD_MS > 0 && speedRows.length) {
  const fastest = speedRows[0].ms;
  if (fastest > SLOW_THRESHOLD_MS) {
   log(`whole pool slow on ${SPEED_MODEL} (fastest ${fastest}ms) — upstream, no speed rotation`);
  } else {
   const slow = speedRows.filter((r) => r.ms > SLOW_THRESHOLD_MS && !dirty.has(r.index));
   if (slow.length) {
    log(`slow (>${SLOW_THRESHOLD_MS}ms, fastest #${speedRows[0].index} ${fastest}ms): ` + slow.map((r) => `#${r.index} ${r.ms}ms`).join(" "));
    for (const row of slow) {
     const entry = relayEntry(state, row.index);
     const at = now();
     const n = entry.consecutiveFailures + 1;
     const verdict = gate(entry, at);
     dirty.add(row.index);
     if (verdict.allowed) {
      ctx.rotations.push({ index: row.index, n, tier2: false, model: null, verify: false });
     } else {
      patchRelay(state, row.index, {
       dirty: true,
       lastProbe: at,
       pendingVerify: false,
       probeAfter: Math.max(entry.cooldownUntil, at + EGRESS_SETTLE_S * 1000),
       consecutiveFailures: n,
      });
      log(`#${row.index} held: ${verdict.reason}`);
     }
    }
   }
  }
 }

 for (const [index, model] of [...signalHot.entries()].sort((a, b) => a[0] - b[0])) {
  classifySignal(index, model, ctx);
 }

 if (ctx.cappedOnly.length) {
  log(`throttled only on quota-capped models (left alone): ${ctx.cappedOnly.sort((a, b) => a - b).map((i) => `#${i}`).join(" ")}`);
 }

 await runPool(ctx.rotations, ROTATE_CONCURRENCY, (job) => runRotation(job, state, dirty));

 // ── summary ──
 const hotDesc = [...ctx.hotRelays.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([i, models]) => `#${i}(${models.join(",")})`)
  .join(" ");
 const seDesc = [...ctx.seRelays.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([i, models]) => `#${i}(${models.join(",")})`)
  .join(" ");
 const cleanCount = COUNT - dirty.size;
 log(`clean ${cleanCount}/${COUNT} relay(s)`
  + (hotDesc ? ` | throttled: ${hotDesc}` : "")
  + (seDesc ? ` | server_error: ${seDesc}` : "")
  + (ctx.cappedOnly.length ? ` | quota-capped: ${ctx.cappedOnly.map((i) => `#${i}`).join(" ")}` : ""));
 if (dirty.size === 0) log("pool is cold");
 else log(`pool is not cold: ${dirty.size} relay(s) held or throttled`);

 // Exit 0 only when every relay is known clean: nothing dirty, nothing
 // quota-capped, nothing troubled, no rotation awaiting verification.
 return dirty.size === 0;
}

// ── Entry point ─────────────────────────────────────────────────────
if (LOOP) {
 log(`loop mode: pass every ${INTERVAL_S}s (Ctrl-C to stop)`);
 for (; ;) {
  const started = Date.now();
  try {
   await pass();
  } catch (e) {
   log(`pass failed: ${shortReason(e).slice(0, 200)}`);
  }
  // Fixed deadline: a slow pass must not push every later pass.
  await new Promise((r) => setTimeout(r, Math.max(0, started + INTERVAL_S * 1_000 - Date.now())));
 }
} else {
 const ok = await pass();
 // exitCode lets stdout drain (process.exit() can drop the final lines).
 process.exitCode = ok ? 0 : 1;
}
