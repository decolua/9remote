// The daemon's per-process KV: state that belongs to a process the daemon holds —
// the chat's token counters, the turn marker — so an agent restart cannot lose it.
// The agent keeps only the key and asks the daemon.
//
// Run: node agent/test/aiDaemonKv.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createKvStore, kvRoutes } from "../features/terminal/daemonKv.js";
import { ROUTES, ALIASES } from "../features/terminal/daemonRoutes.js";
import { createRouter } from "../features/terminal/daemonRouter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const root = path.join(import.meta.dirname, "..", "..");

console.log("Running daemon KV tests...");

test("the store keeps, overwrites, deletes, and detaches values", () => {
  const kv = createKvStore(10);
  const stats = { inputTokens: 5 };
  kv.set("ai:s1", { stats });
  stats.inputTokens = 99; // mutating the caller's object must not leak in
  assert.deepEqual(kv.get("ai:s1"), { stats: { inputTokens: 5 } });
  kv.set("ai:s1", { stats: { inputTokens: 7 } }); // last write wins
  assert.equal(kv.get("ai:s1").stats.inputTokens, 7);
  assert.equal(kv.get("ai:nope"), null);
  kv.del("ai:s1");
  assert.equal(kv.get("ai:s1"), null);
});

test("the store sheds the OLDEST key past its cap — a leak would grow the daemon forever", () => {
  const kv = createKvStore(3);
  for (let i = 0; i < 5; i++) kv.set(`k${i}`, { i });
  assert.equal(kv.get("k0"), null, "the oldest went first");
  assert.deepEqual(kv.get("k4"), { i: 4 }, "the newest stayed");
});

test("the routes answer set/get/del through the real router", async () => {
  const store = createKvStore(10);
  const replies = [];
  const router = createRouter({ deps: { kv: store }, send: (client, msg) => replies.push(msg) });
  router.register("kv", kvRoutes); // assertComplete is the real daemon's boot check —
  // this router serves only the kv domain.
  const client = {};
  const ask = (type, body) => router.enqueue({ client, message: { type, requestId: type + Math.random(), ...body } });
  ask("kv.set", { key: "ai:s1", value: { stats: { inputTokens: 3 }, turn: { running: true } } });
  ask("kv.get", { key: "ai:s1" });
  ask("kv.del", { key: "ai:s1" });
  await new Promise((r) => setTimeout(r, 30));
  const got = replies.find((m) => m.type === "kvGetResult");
  assert.ok(got, "the get answered");
  assert.deepEqual(got.value, { stats: { inputTokens: 3 }, turn: { running: true } });
  assert.equal(got.success, true);
});

test("the route table declares the kv contract, and only set may coalesce", () => {
  assert.equal(ROUTES["kv.set"].reply, "kvSetResult");
  assert.equal(ROUTES["kv.set"].coalesce, null);   // a shared slot would drop another chat's write
  assert.equal(ROUTES["kv.get"].reply, "kvGetResult");
  assert.equal(ROUTES["kv.get"].coalesce, null);   // each asker must get its own answer
  assert.equal(ROUTES["kv.del"].reply, "kvDelResult");
  // The wire aliases an older agent may still speak.
  assert.equal(ALIASES.kvSet, "kv.set");
  assert.equal(ALIASES.kvGet, "kv.get");
  assert.equal(ALIASES.kvDel, "kv.del");
});

test("the agent writes a session's state at the turn's edges and restores it on rebuild", () => {
  // Source assertions, the convention aiDaemonSession uses for cross-process wiring:
  // the write rides the turn-end branch, the restore runs before the session serves.
  const SESSION = fs.readFileSync(path.join(root, "agent/features/ai/aiSession.js"), "utf8");
  assert.match(SESSION, /kvSet\(/, "the session must write to the daemon KV");
  assert.match(SESSION, /kvGet\(/, "the session must restore from the daemon KV");
  assert.match(SESSION, /turn: \{/, "turn state is tracked");
  assert.match(SESSION, /lastPrompt:/, "lastPrompt is carried in daemon KV");
  assert.match(SESSION, /threadTitle:/, "threadTitle is carried in daemon KV");
  assert.match(SESSION, /carried:/, "carried task records are preserved in daemon KV");
  assert.match(SESSION, /permissionMode: this\.permissionMode/, "the user's mode is carried in daemon KV");
  assert.match(SESSION, /model: this\.model/, "the model pick is carried in daemon KV");
  assert.match(SESSION, /effort: this\.effort/, "the effort pick is carried in daemon KV");
  assert.match(SESSION, /pendingPermission: this\.pendingPermission/, "an open gate is carried in daemon KV");
  assert.match(SESSION, /consumedLines: this\.consumedLines/, "the line watermark is carried in daemon KV");
  // The seeding moved to the engine registry (adapters/index.js) with the refactor.
  const ENGINES = fs.readFileSync(path.join(root, "agent/features/ai/adapters/index.js"), "utf8");
  assert.match(ENGINES, /adapter\.currentMode = ctx\.mode/, "the adapter is seeded with the restored mode before adopt");
  const CLIENT = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemonClient.js"), "utf8");
  assert.match(CLIENT, /export async function kvSet/, "the client must expose kvSet");
  assert.match(CLIENT, /export async function kvGet/, "the client must expose kvGet");
});

test("proc.attach and adapter.adopt accept both positional and object arguments", () => {
  // Positional (from, epoch) vs object { from, epoch } mismatch broke adopt on restart.
  for (const file of [
    "agent/features/ai/proc/daemonProc.js",
    "agent/features/ai/proc/agentProc.js",
    "agent/features/ai/adapters/codexAdapter.js",
    "agent/features/ai/adapters/antigravityAdapter.js",
    "agent/features/ai/adapters/opencodeAdapter.js",
    "agent/features/ai/adapters/claudeAdapter.js"
  ]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(src, /typeof from === "object"/, `${file} must normalize object vs positional 'from' argument`);
  }
});

test("the daemon runtime copy includes the kv module, and the version is bumped", () => {
  // The daemon runs from a versioned copy — a module it imports must be listed or the
  // new daemon cannot even boot, and without a bump the old runtime keeps serving.
  const CLIENT = fs.readFileSync(path.join(root, "agent/features/terminal/ptyDaemonClient.js"), "utf8");
  assert.match(CLIENT, /DAEMON_LOCAL_MODULES = \[[^\]]*"daemonKv.js"/, "daemonKv.js must ship in the runtime copy");
  const CONST = fs.readFileSync(path.join(root, "agent/features/terminal/constants.js"), "utf8");
  assert.match(CONST, /DAEMON_VERSION = "71"/, "the daemon version must be bumped past 70");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
