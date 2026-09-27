// A lost step.ended (SSE reconnect, server blip) must not spin the turn until the
// 120s idle watchdog: on every bus reconnect the adapter reconciles with the
// server's active-session map and settles the turn if the engine went idle.
// Run: node agent/test/opencodeReconnect.test.mjs
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeAdapter(active = {}) {
  const events = [];
  const serverMock = {
    listCommands: async () => [], runCommand: async () => ({}), createSession: async () => ({ id: "ses_t" }),
    prompt: async () => {}, setSessionModel: async () => {}, setSessionAgent: async () => {},
    interruptSession: async () => {},
    activeSessions: async () => active,
    subscribeBus: (onEvent, opts = {}) => {
      // Expose reconnect so the test can fire it like the bus loop would.
      return { close() {}, reconnect: () => opts.onReconnect?.() };
    },
  };
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]), server: serverMock });
  adapter.activeSessionId = "ses_t";
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running opencode reconnect reconcile tests...");

await test("the bus hands the adapter a reconnect hook", () => {
  const { adapter } = makeAdapter();
  adapter._ensureBus();
  assert.equal(typeof adapter.bus.reconnect, "function");
});

await test("an idle engine settles a running turn on reconnect", async () => {
  const { adapter, of } = makeAdapter({});
  adapter._ensureBus();
  adapter.isTurnRunning = true;
  adapter.bus.reconnect();
  await tick();
  assert.equal(adapter.isTurnRunning, false);
  assert.equal(of("turn_complete").length, 1);
});

await test("an engine still running changes nothing", async () => {
  const { adapter, of } = makeAdapter({ ses_t: { type: "busy" } });
  adapter._ensureBus();
  adapter.isTurnRunning = true;
  adapter.bus.reconnect();
  await tick();
  assert.equal(adapter.isTurnRunning, true);
  assert.equal(of("turn_complete").length, 0);
});

await test("no reconciliation while no turn runs", async () => {
  const { adapter, of } = makeAdapter({});
  adapter._ensureBus();
  adapter.bus.reconnect();
  await tick();
  assert.equal(of("turn_complete").length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
