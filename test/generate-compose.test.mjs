// Generator tests: the generated compose file is a build input, so its
// invariants are asserted here instead of relying on a human diff review.
//
// Regression coverage for issue #24 (every warp-N service declared
// `build: ./warp-lite`, so `docker compose up --build` ran several concurrent
// builds of the same tag and failed with `AlreadyExists`), plus the optional
// MASQUE engine switch (issue #25) and its byte-identical default output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GENERATOR = path.join(REPO_ROOT, "generate-compose.sh");

/**
 * Run the generator inside a throwaway copy of the scripts it needs, so the
 * repo's tracked docker-compose.yml is never rewritten by a test run.
 */
function generate(args, { env = {} } = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrp-generate-"));
 fs.copyFileSync(GENERATOR, path.join(dir, "generate-compose.sh"));
 fs.mkdirSync(path.join(dir, "warp-lite"));
 const clean = { ...process.env };
 // A stray COUNT/NODE_ENGINE in the caller's environment must not leak in.
 for (const key of ["COUNT", "NODE_ENGINE", "MASQUE_MODE", "WARP_BIND", "INGRESS_BIND"]) delete clean[key];
 const r = spawnSync("sh", ["./generate-compose.sh", ...args], {
  cwd: dir,
  encoding: "utf8",
  env: { ...clean, ...env },
 });
 const file = path.join(dir, "docker-compose.yml");
 const compose = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
 fs.rmSync(dir, { recursive: true, force: true });
 return { code: r.status, stdout: r.stdout, stderr: r.stderr, compose };
}

function services(compose) {
 const out = new Map();
 let current = null;
 for (const line of compose.split("\n")) {
  const svc = line.match(/^ {2}([A-Za-z0-9_.-]+):$/);
  if (svc) {
   current = svc[1];
   out.set(current, []);
   continue;
  }
  if (current) out.get(current).push(line);
 }
 return out;
}

test("no warp-N service declares a build context (issue #24)", () => {
 const { code, compose, stderr } = generate(["10"]);
 assert.equal(code, 0, stderr);
 const warp = [...services(compose).entries()].filter(([name]) => /^warp-\d+$/.test(name));
 assert.equal(warp.length, 10);
 for (const [name, body] of warp) {
  assert.ok(
   !body.some((line) => /^ {4}build:/.test(line)),
   `${name} must not declare a build context (Compose would build warp-lite:latest once per service)`,
  );
  assert.ok(body.some((line) => line.trim() === "image: warp-lite:latest"), `${name} must reference the prebuilt tag`);
 }
});

test("the relay app keeps its own build context (issue #24)", () => {
 const { compose } = generate(["3"]);
 const relay = services(compose).get("relay");
 assert.ok(relay, "relay service missing");
 assert.ok(relay.some((line) => line.trim() === "build: ."), "relay must keep `build: .`");
});

test("default generation is deterministic and matches the tracked compose file", () => {
 const tracked = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
 const { code, compose, stderr } = generate(["10"]);
 assert.equal(code, 0, stderr);
 assert.equal(compose, tracked, "docker-compose.yml is stale: run `sh ./generate-compose.sh 10` and commit");
});

test("--node-engine=microwarp emits MASQUE nodes with the same SOCKS contract", () => {
 const { code, compose, stderr } = generate(["3", "--node-engine=microwarp"]);
 assert.equal(code, 0, stderr);
 const svcs = services(compose);
 const warp = [...svcs.entries()].filter(([name]) => /^warp-\d+$/.test(name));
 assert.equal(warp.length, 3);
 for (const [name, body] of warp) {
  const text = body.join("\n");
  assert.match(text, /image: ghcr\.io\/ccbkkb\/microwarp:latest/, `${name} image`);
  assert.match(text, /TUNNEL_PROTOCOL=masque/, `${name} protocol`);
  assert.match(text, /MASQUE_PROXY_MODE=socks/, `${name} default proxy mode`);
  assert.match(text, new RegExp(`container_name: warp-relay-warp-${name.slice(5)}`), `${name} container name`);
  assert.match(text, /127\.0\.0\.1:108\d\d:1080/, `${name} must publish SOCKS on the same host port contract`);
  assert.match(text, /masque-config\.json:\/etc\/wireguard\/masque-config\.json:ro/, `${name} device config mount`);
  assert.doesNotMatch(text, /NET_ADMIN/, `${name}: socks mode needs no privileges`);
 }
 assert.ok(!compose.includes("warp-data-"), "MASQUE nodes use bind-mounted configs, not named volumes");
 assert.ok(svcs.has("relay"), "relay service must still be generated");
});

test("--masque-proxy-mode=l4-socks grants NET_ADMIN and is recorded in the header", () => {
 const { code, compose, stderr } = generate(["2", "--node-engine=microwarp", "--masque-proxy-mode=l4-socks"]);
 assert.equal(code, 0, stderr);
 const warp1 = services(compose).get("warp-1");
 const text = warp1.join("\n");
 assert.match(text, /MASQUE_PROXY_MODE=l4-socks/);
 assert.match(text, /NET_ADMIN/, "l4-socks drives a TUN device and needs NET_ADMIN");
 assert.match(compose, /Regenerate: \.\/generate-compose\.sh 2 --node-engine=microwarp --masque-proxy-mode=l4-socks/);
});

test("an invalid --node-engine or --masque-proxy-mode fails before writing", () => {
 const bad = generate(["2", "--node-engine=bogus"]);
 assert.equal(bad.code, 1);
 assert.match(bad.stderr, /--node-engine must be warp-lite or microwarp/);
 assert.equal(bad.compose, "", "no compose file on a rejected engine");

 const badMode = generate(["2", "--node-engine=microwarp", "--masque-proxy-mode=bogus"]);
 assert.equal(badMode.code, 1);
 assert.match(badMode.stderr, /--masque-proxy-mode must be socks or l4-socks/);
});

test("--legacy-warp and --node-engine=microwarp are mutually exclusive", () => {
 const r = generate(["2", "--legacy-warp", "--node-engine=microwarp"]);
 assert.equal(r.code, 1);
 assert.match(r.stderr, /mutually exclusive/);
});

test("a default run stays byte-identical even with the engine knob present in the environment", () => {
 const plain = generate(["4"]);
 const pinned = generate(["4"], { env: { NODE_ENGINE: "warp-lite", MASQUE_MODE: "socks" } });
 assert.equal(pinned.compose, plain.compose, "default engine output must not change");
});
