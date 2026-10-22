// Live rate-limit signals.
//
// The relay already sees the upstream status of every proxied request, so it
// can name the egress that is actually throttled instead of making keep-cold
// probe to find out. Only state changes are written (the first 429 for a
// (relay, model) pair inside a window, and the recovery that follows it), and
// every write goes through tmp + rename because the deployment host runs on a
// saturated 5400 rpm disk.
import fs from "node:fs";
import path from "node:path";

const THROTTLE = 429;
const RECOVERY = 200;

export function createSignalWriter({
  file,
  windowMs = 300_000,
  maxRecords = 200,
  flushMs = 250,
  now = Date.now,
  log = console.error,
} = {}) {
  const target = path.resolve(String(file ?? ".keep-cold/signals.json"));
  const tmp = `${target}.${process.pid}.tmp`;
  const limit = Math.max(1, Math.floor(Number(maxRecords)) || 1);
  const window = Math.max(0, Number(windowMs) || 0);
  const delay = Number.isFinite(flushMs) && flushMs > 0 ? flushMs : 0;
  // The 429 state map is keyed by (relay, model) and lives only as long as
  // one window, so it is pruned instead of growing with distinct models.
  const stateCap = Math.max(64, limit * 4);

  const pending = [];
  const throttled = new Map();
  let timer = null;
  let loggedFailure = false;

  function logFailure(err) {
    if (loggedFailure) return;
    loggedFailure = true;
    try {
      log(`[relay] signal write failed: ${err?.code || err?.message || String(err)}`);
    } catch {
      // Logging must never be the reason a relay request fails.
    }
  }

  function track(key, ts) {
    // Re-insert so Map order stays roughly insertion-recency order.
    throttled.delete(key);
    throttled.set(key, ts);
    if (throttled.size <= stateCap) return;
    for (const [k, v] of throttled) {
      if (ts - v >= window) throttled.delete(k);
    }
    for (const k of throttled.keys()) {
      if (throttled.size <= stateCap) break;
      throttled.delete(k);
    }
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
    timer.unref?.();
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    try {
      let existing = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
        if (Array.isArray(parsed?.signals)) existing = parsed.signals;
      } catch {
        // Missing or corrupt file: the new records are the whole file.
      }
      const merged = existing.concat(pending);
      const records = merged.length > limit ? merged.slice(merged.length - limit) : merged;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ signals: records })}\n`);
      fs.renameSync(tmp, target);
      pending.length = 0;
    } catch (err) {
      logFailure(err);
      // Keep `pending` (bounded by `limit`) so a later flush can still land
      // it; no retry loop of our own.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  function record({ relay, model, status, retryAfter } = {}) {
    if (!Number.isInteger(relay)) return;
    if (typeof model !== "string" || model === "") return;
    if (status !== THROTTLE && status !== RECOVERY) return;

    const key = `${relay}|${model}`;
    const ts = now();
    const since = throttled.get(key);

    if (status === THROTTLE) {
      // One record per (relay, model) per window: the throttle is the state,
      // not each request that hits it.
      if (since !== undefined && ts - since < window) return;
      track(key, ts);
      pending.push({ ts, relay, model, status: THROTTLE, retryAfter: Number(retryAfter) || null });
    } else {
      // Recovery only means something while the throttle state is live.
      if (since === undefined || ts - since >= window) {
        throttled.delete(key);
        return;
      }
      throttled.delete(key);
      pending.push({ ts, relay, model, status: RECOVERY, retryAfter: null });
    }

    if (pending.length > limit) pending.splice(0, pending.length - limit);
    schedule();
  }

  return { record, flush };
}
