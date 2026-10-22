// Unit tests for the live rate-limit signal writer. The writer is the only
// thing standing between upstream 429s and keep-cold's rotation decisions, so
// the dedupe rules (one record per (relay, model) per window, recovery only
// after a live throttle) are asserted directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSignalWriter } from "../signal-writer.mjs";

const WINDOW_MS = 300_000;
const silent = () => {};

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-writer-"));
  return { dir, file: path.join(dir, ".keep-cold", "signals.json") };
}

function readSignals(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.signals;
}

function writerAt(file, opts = {}) {
  let clock = 1_000;
  const writer = createSignalWriter({
    file,
    windowMs: WINDOW_MS,
    log: silent,
    now: () => clock,
    ...opts,
  });
  return { writer, tick: (ms) => (clock += ms), clock: () => clock };
}

test("first 429 writes exactly one record with the documented shape", () => {
  const { file, dir } = tmpFile();
  const { writer, clock } = writerAt(file);
  try {
    writer.record({ relay: 7, model: "test/model-a", status: 429, retryAfter: 30 });
    writer.flush();
    const signals = readSignals(file);
    assert.deepEqual(signals, [
      { ts: clock(), relay: 7, model: "test/model-a", status: 429, retryAfter: 30 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeat 429s inside the window are not written again", () => {
  const { file, dir } = tmpFile();
  const { writer, tick } = writerAt(file);
  try {
    writer.record({ relay: 3, model: "m", status: 429, retryAfter: 5 });
    writer.flush();
    tick(WINDOW_MS - 1);
    for (let i = 0; i < 5; i++) writer.record({ relay: 3, model: "m", status: 429, retryAfter: 5 });
    writer.flush();
    assert.equal(readSignals(file).length, 1);
    // A different relay is a different key and does get its own record.
    writer.record({ relay: 4, model: "m", status: 429 });
    writer.flush();
    assert.equal(readSignals(file).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("429 after the window elapses writes a second record", () => {
  const { file, dir } = tmpFile();
  const { writer, tick } = writerAt(file);
  try {
    writer.record({ relay: 1, model: "m", status: 429 });
    writer.flush();
    tick(WINDOW_MS);
    writer.record({ relay: 1, model: "m", status: 429, retryAfter: 2 });
    writer.flush();
    const signals = readSignals(file);
    assert.equal(signals.length, 2);
    assert.equal(signals[1].status, 429);
    assert.equal(signals[1].retryAfter, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 200 after a 429 writes a recovery record and clears the state", () => {
  const { file, dir } = tmpFile();
  const { writer, tick } = writerAt(file);
  try {
    writer.record({ relay: 9, model: "m", status: 429, retryAfter: 7 });
    writer.flush();
    tick(1_000);
    writer.record({ relay: 9, model: "m", status: 200 });
    writer.flush();
    let signals = readSignals(file);
    assert.equal(signals.length, 2);
    assert.deepEqual(signals[1], { ts: signals[1].ts, relay: 9, model: "m", status: 200, retryAfter: null });

    // State was cleared, so a second success is a no-op...
    tick(1_000);
    writer.record({ relay: 9, model: "m", status: 200 });
    writer.flush();
    assert.equal(readSignals(file).length, 2);

    // ...and a new 429 after recovery is a fresh state change.
    tick(1_000);
    writer.record({ relay: 9, model: "m", status: 429 });
    writer.flush();
    signals = readSignals(file);
    assert.equal(signals.length, 3);
    assert.equal(signals[2].status, 429);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery without a prior 429, or after the window, writes nothing", () => {
  const { file, dir } = tmpFile();
  const { writer, tick } = writerAt(file);
  try {
    writer.record({ relay: 1, model: "never-throttled", status: 200 });
    writer.flush();
    assert.equal(fs.existsSync(file), false);

    writer.record({ relay: 1, model: "stale", status: 429 });
    writer.flush();
    tick(WINDOW_MS + 1);
    writer.record({ relay: 1, model: "stale", status: 200 });
    writer.flush();
    assert.deepEqual(readSignals(file).map((s) => s.status), [429]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid records are ignored without throwing", () => {
  const { file, dir } = tmpFile();
  const { writer } = writerAt(file);
  try {
    writer.record();
    writer.record({ relay: "7", model: "m", status: 429 });
    writer.record({ relay: 7.5, model: "m", status: 429 });
    writer.record({ relay: 7, model: "", status: 429 });
    writer.record({ relay: 7, model: 12, status: 429 });
    writer.record({ relay: 7, model: "m", status: 500 });
    writer.record({ relay: 7, model: "m", status: "429" });
    writer.flush();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("records are capped at maxRecords, dropping the oldest", () => {
  const { file, dir } = tmpFile();
  const { writer } = writerAt(file, { maxRecords: 3 });
  try {
    for (let relay = 1; relay <= 5; relay++) {
      writer.record({ relay, model: "m", status: 429 });
    }
    writer.flush();
    assert.deepEqual(readSignals(file).map((s) => s.relay), [3, 4, 5]);

    // A second batch merges with the file and still caps.
    for (let relay = 6; relay <= 8; relay++) {
      writer.record({ relay, model: "m", status: 429 });
    }
    writer.flush();
    assert.deepEqual(readSignals(file).map((s) => s.relay), [6, 7, 8]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt pre-existing file is replaced instead of failing", () => {
  const { file, dir } = tmpFile();
  const { writer } = writerAt(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    writer.record({ relay: 2, model: "m", status: 429 });
    writer.flush();
    const signals = readSignals(file);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].relay, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing signals array is preserved and merged", () => {
  const { file, dir } = tmpFile();
  const { writer } = writerAt(file, { maxRecords: 10 });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ signals: [{ ts: 1, relay: 1, model: "old", status: 429, retryAfter: null }] }),
    );
    writer.record({ relay: 2, model: "new", status: 429 });
    writer.flush();
    assert.deepEqual(readSignals(file).map((s) => s.model), ["old", "new"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable path never throws and logs at most one line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-writer-"));
  const blocker = path.join(dir, "blocker");
  const lines = [];
  try {
    fs.writeFileSync(blocker, "regular file");
    const writer = createSignalWriter({
      file: path.join(blocker, "signals.json"),
      log: (line) => lines.push(line),
    });
    writer.record({ relay: 1, model: "m", status: 429 });
    writer.flush();
    writer.record({ relay: 2, model: "m", status: 429 });
    writer.flush();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /signal write failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a record schedules one coalesced flush", async () => {
  const { file, dir } = tmpFile();
  const writer = createSignalWriter({ file, flushMs: 20, log: silent });
  try {
    writer.record({ relay: 1, model: "a", status: 429 });
    writer.record({ relay: 2, model: "b", status: 429 });
    assert.equal(fs.existsSync(file), false);
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(readSignals(file).map((s) => s.relay), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
