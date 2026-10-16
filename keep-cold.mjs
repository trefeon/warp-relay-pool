#!/usr/bin/env node
/**
 * keep-cold-lite.mjs — MicroWARP port of keep-cold.mjs (copy + 4 deltas, 2026-10-05; serverError class 2026-10-05).
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
 *   PROBE_MODELS        comma-separated models to probe (default
 *                       nemotron-3.5-lightning-free,mimo-v2.5-free,
 *                       muse-spark-1.3-contributor-free — two chat families
 *                       plus one responses model so per-model throttles on
 *                       either wire path are caught)
 *   PROBE_MODEL         legacy single-model override (used only when
 *                       PROBE_MODELS is unset)
 *   RESPONSES_MODELS    comma-separated models served via /zen/v1/responses
 *                       (default muse-spark-1.2-contributor-free,
 *                       muse-spark-1.3-contributor-free; everything else
 *                       probes via /zen/v1/chat/completions)
 *   GLOBAL_QUOTA_GUARD  relays-429ed threshold at which a model counts as
 *                       upstream quota, not egress throttle (default 5;
 *                       capped at COUNT). Quota-capped models are skipped
 *                       for rotation this pass.
 *   SERVER_ERROR_RETRY    same-egress re-probes before a server_error
 *                       rotation (default 1 — stateless transient filter)
 *   SERVER_ERROR_REPROBE_MS  delay before each re-probe (default 5000)
 *   SERVER_ERROR_GUARD    relays-with-server_error threshold at which a model
 *                       counts as upstream incident, not egress fault
 *                       (default 9, capped at COUNT)
 *   SPEED_MODEL         model whose latency decides slow rotation (default
 *                       muse-spark-1.3-contributor-free — the main daily
 *                       driver; must be in PROBE_MODELS to have timings)
 *   SLOW_THRESHOLD_MS   200-response slower than this is rotated for speed
 *                       (default 0 = DISABLED — single-sample rank proven
 *                       upstream noise 2026-10-02; re-enable only on
 *                       median-over-N evidence)
 *   SLOW_MAX_ROTATIONS  restarts per slow relay per pass (default 2 —
 *                       separate budget from the 429 path)
 *   CONTAINER_PREFIX    docker container prefix       (default warp-relay-warp-)
 *   READY_TIMEOUT_MS    wait for a rotated relay      (default 180000)
 *   PROBE_TIMEOUT_MS    per-probe request timeout     (default 30000)
 *   MAX_ROTATIONS       restarts per relay per pass   (default 4)
 *   ROTATE_CONCURRENCY  parallel restarts             (default 3)
 *   INTERVAL_S          seconds between loop passes   (default 300)
 *   KEEP_COLD_LOG       append the log to this file   (default stdout only)
 *   KEEP_COLD_LOG_MAX_BYTES  rotate above this size    (default 2 MiB)
 *   KEEP_COLD_LOG_KEEP_BYTES keep this much on rotate   (default 200 KiB)
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

const RELAY_HOST = process.env.RELAY_HOST ?? "10.244.0.100";
const SOCKS_HOST = process.env.SOCKS_HOST ?? "127.0.0.1";
const BASE_PORT = Number(process.env.BASE_PORT ?? 3000);
const COUNT = Number(process.env.COUNT ?? 10);
const PROBE_MODELS = (process.env.PROBE_MODELS
 ?? process.env.PROBE_MODEL
 ?? "nemotron-3.5-lightning-free,mimo-v2.5-free,muse-spark-1.3-contributor-free")
 .split(",")
 .map((s) => s.trim())
 .filter(Boolean);
const RESPONSES_MODELS = new Set(
 (process.env.RESPONSES_MODELS
  ?? "muse-spark-1.2-contributor-free,muse-spark-1.3-contributor-free")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean),
);
const GLOBAL_QUOTA_GUARD = Math.min(Number(process.env.GLOBAL_QUOTA_GUARD ?? Math.max(8, COUNT - 1)), COUNT);
const SPEED_MODEL = process.env.SPEED_MODEL ?? "muse-spark-1.3-contributor-free";
const SLOW_THRESHOLD_MS = Number(process.env.SLOW_THRESHOLD_MS ?? 0);
const SLOW_MAX_ROTATIONS = Number(process.env.SLOW_MAX_ROTATIONS ?? 2);
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX ?? "warp-relay-warp-";
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 180_000);
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 30_000);
const MAX_ROTATIONS = Number(process.env.MAX_ROTATIONS ?? 4);
const ROTATE_CONCURRENCY = Number(process.env.ROTATE_CONCURRENCY ?? 1);
const SERVER_ERROR_RETRY = Number(process.env.SERVER_ERROR_RETRY ?? 1);
const SERVER_ERROR_REPROBE_MS = Number(process.env.SERVER_ERROR_REPROBE_MS ?? 5_000);
const SERVER_ERROR_GUARD = Math.min(Number(process.env.SERVER_ERROR_GUARD ?? 9), COUNT);
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 300);
const LOOP = process.argv.includes("--loop");

// ── Upstream fingerprint ────────────────────────────────────────────
// The free tier rejects requests that do not look like the official client, so
// the probe must carry the same headers and tool declarations the proxy sends.
// A rejected probe (403) would hide the 429 we are actually looking for.
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
   relayPath: "/zen/v1/responses",
   body: JSON.stringify({
    model,
    input: "ping",
    stream: true,
    tools: RESPONSE_PLACEHOLDER_TOOLS,
   }),
  };
 }
 return {
  relayPath: "/zen/v1/chat/completions",
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
  "x-relay-target": "https://opencode.ai",
  "x-relay-path": relayPath,
  accept: "text/event-stream",
 };
}

// ── Logging ─────────────────────────────────────────────────────────
const LOG_PATH = process.env.KEEP_COLD_LOG ?? "";
const LOG_MAX_BYTES = Number(process.env.KEEP_COLD_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
const LOG_KEEP_BYTES = Number(process.env.KEEP_COLD_LOG_KEEP_BYTES ?? 200 * 1024);

/** Trim the log in place once it passes the cap, keeping the newest slice. */
function rotateLogIfNeeded() {
 try {
  if (fs.statSync(LOG_PATH).size <= LOG_MAX_BYTES) return;
  const buf = fs.readFileSync(LOG_PATH);
  fs.writeFileSync(LOG_PATH, buf.subarray(Math.max(0, buf.length - LOG_KEEP_BYTES)));
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

function docker(args, timeout = 30_000) {
 return execFileSync("docker", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout,
 });
}

/** True when the WARP client egresses with WARP on (host-side SOCKS check). */
function warpReady(index) {
 try {
  // MicroWARP has no warp-cli and no guaranteed curl — check from the deploy
  // host via SOCKS instead of docker-exec.
  const trace = execFileSync("curl", ["-s", "-m", "10", "-x", `socks5h://${SOCKS_HOST}:${10800 + index}`, "https://cloudflare.com/cdn-cgi/trace"], { encoding: "utf8", timeout: 15_000 });
  return /^ip=/m.test(trace) && /warp=on/m.test(trace);
 } catch {
  return false;
 }
}

/** Egress address of a relay, for the log line. */
function egressIp(index) {
 try {
  // MicroWARP has no docker-exec curl — probe from the deploy host via SOCKS.
  const trace = execFileSync("curl", ["-s", "-m", "10", "-x", `socks5h://${SOCKS_HOST}:${10800 + index}`, "https://cloudflare.com/cdn-cgi/trace"], { encoding: "utf8", timeout: 15_000 });
  return (trace.match(/^ip=(.+)$/m)?.[1] ?? "?").trim();
 } catch {
  return "?";
 }
}

async function waitReady(index, deadline) {
 while (Date.now() < deadline) {
  if (warpReady(index)) return true;
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
   const head = await readEnvelopeHead(res).catch(() => "");
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

/**
 * Restart the WARP client container until every given model answers 200
 * (and, when `speed` is set, the speed model answers within threshold).
 * 429 path uses MAX_ROTATIONS; speed-only retries use SLOW_MAX_ROTATIONS.
 * Two-tier per attempt: tier 1 (t1) plain restart, tier 2 (t2) exec-wipe of
 * wg0.conf + restart. Nodes without wg0.conf skip tier 2 (abort, no wipe).
 */
async function rotateUntilClean(index, models, speed = null) {
 const maxAttempts = speed ? SLOW_MAX_ROTATIONS : MAX_ROTATIONS;
 for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  log(`#${index} rotating egress (attempt ${attempt}/${maxAttempts} t1) — restarting ${containerName(index)}`);
  try {
   // Tier 1: plain restart - same account, fresh egress /64. Cheap, zero
   // registration-quota cost; clears per-egress-IP throttles.
   docker(["restart", containerName(index)], 60_000);
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
  if (failing.length === 0) {
   if (speed) {
    const t = results.find((r) => r.model === speed.model)?.ms ?? Infinity;
    if (t <= speed.threshold) {
     log(`#${index} fast on ${models.length} model(s) (${speed.model} ${t}ms) — new egress ${egressIp(index)}`);
     return true;
    }
    log(`#${index} still slow after rotation: ${speed.model} ${t}ms > ${speed.threshold}ms`);
    continue;
   }
   log(`#${index} clean on ${models.length} model(s) — new egress ${egressIp(index)}`);
   return true;
  }
  // Tier 2: tier 1 did not clear it - re-key with a fresh registration (new
  // account/keys). Spends one Cloudflare registration; clears per-account
  // throttles. Nodes without wg0.conf (e.g. caomingjun) are not re-keyable:
  // abort the re-key instead of forcing a wipe.
  log(`#${index} rotating egress (attempt ${attempt}/${maxAttempts} t2) — re-keying ${containerName(index)}`);
  let rekeyable = true;
  try {
   docker(["exec", containerName(index), "test", "-f", "/etc/wireguard/wg0.conf"], 30_000);
  } catch {
   rekeyable = false;
  }
  if (!rekeyable) {
   log(`#${index} tier-2 aborted: no /etc/wireguard/wg0.conf — leaving registration untouched`);
  } else {
   try {
    docker(["exec", containerName(index), "rm", "-f", "/etc/wireguard/wg0.conf"], 30_000);
    docker(["restart", containerName(index)], 60_000);
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
   if (failing2.length === 0) {
    if (speed) {
     const t2 = results2.find((r) => r.model === speed.model)?.ms ?? Infinity;
     if (t2 <= speed.threshold) {
      log(`#${index} fast on ${models.length} model(s) (${speed.model} ${t2}ms) — new egress ${egressIp(index)}`);
      return true;
     }
     log(`#${index} still slow after rotation: ${speed.model} ${t2}ms > ${speed.threshold}ms`);
     continue;
    }
    log(`#${index} clean on ${models.length} model(s) — new egress ${egressIp(index)}`);
    return true;
   }
  }
  log(`#${index} still failing after rotation: ${failing.map((r) => `${r.model}=${r.status || "unreachable"}`).join(", ")}`);
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
  docker(["restart", containerName(index)], 60_000);
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
  log(`#${index} clean on ${models.length} model(s) — new egress ${egressIp(index)}`);
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

 const hotDesc = [...hot.entries()].map(([i, ms]) => `#${i}(${ms.join(",")})`).join(" ");
 const serverErrDesc = [...serverErr.entries()].map(([i, rs]) => `#${i}(${rs.map((r) => r.model).join(",")})`).join(" ");
 log(`clean ${COUNT - new Set([...hot.keys(), ...serverErr.keys(), ...troubled.map((r) => r.index)]).size}/${COUNT} relay(s)` + (hot.size ? ` | throttled: ${hotDesc}` : "") + (serverErr.size ? ` | server_error: ${serverErrDesc}` : ""));
 for (const r of troubled) log(`#${r.index} ${r.model} unexpected HTTP ${r.status || "unreachable"} — ${r.detail}`);

 if (hot.size === 0 && slow.size === 0 && serverErr.size === 0) {
  log("pool is cold");
  return troubled.length === 0;
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
 await runPool([...hot.keys()], ROTATE_CONCURRENCY, async (index) => {
  const recovered = await rotateUntilClean(index, rotatable);
  if (!recovered) allRecovered = false;
 });
 const speedSpec = { model: SPEED_MODEL, threshold: SLOW_THRESHOLD_MS };
 await runPool([...slow.keys()], ROTATE_CONCURRENCY, async (index) => {
  const recovered = await rotateUntilClean(index, rotatable, speedSpec);
  if (!recovered) allRecovered = false;
 });
 return allRecovered && troubled.length === 0 && serverHold.length === 0;
}

// ── Entry point ─────────────────────────────────────────────────────
if (LOOP) {
 log(`loop mode: pass every ${INTERVAL_S}s (Ctrl-C to stop)`);
 for (; ;) {
  try {
   await pass();
  } catch (e) {
   log(`pass failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1_000));
 }
} else {
 const ok = await pass();
 process.exit(ok ? 0 : 1);
}
