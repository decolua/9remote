// Mode switch = agent switch on the v2 server (opencode's agent IS its mode:
// build = full access, plan = read-only). Measured: the v2 runner reads only
// agent.permissions, so a v1 session ruleset PATCH would be inert.
// Run: node agent/test/opencodeModes.test.mjs
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import { OPENCODE_MODE_AGENTS } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function fakeServer() {
  const state = { agents: [], prompted: [], created: [], currentAgent: "" };
  return {
    state,
    listCommands: async () => [],
    runCommand: async () => ({}),
    createSession: async (cwd, extras) => {
      state.created.push(extras);
      state.currentAgent = extras.agent || "";
      return { id: "ses_new" };
    },
    prompt: async (sessionId, body) => { state.prompted.push(body); },
    setSessionModel: async () => {},
    getSession: async () => ({ agent: state.currentAgent }),
    setSessionAgent: async (sessionId, agent) => { state.agents.push({ sessionId, agent }); state.currentAgent = agent; },
    interruptSession: async () => {},
    activeSessions: async () => ({}),
    subscribeBus: () => ({ close() {} }),
  };
}

function makeAdapter(server, mode) {
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: () => {}, server });
  adapter.setOptions(mode ? { mode } : {});
  return adapter;
}

console.log("Running opencode mode→agent tests...");

await test("the mode table maps onto real agent ids", () => {
  assert.equal(OPENCODE_MODE_AGENTS.auto, "build");
  assert.equal(OPENCODE_MODE_AGENTS.plan, "plan");
});

await test("first prompt is BORN with the mode's agent, no PATCH", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "plan");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  assert.deepEqual(server.state.created[0], { agent: "plan" });
  assert.deepEqual(server.state.agents, [], "no agent PATCH may ride the first turn");
  assert.ok(server.state.prompted.length, "prompt must still go out");
});

await test("switching mode between turns switches the agent", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "auto");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  assert.equal(server.state.created[0].agent, "build");
  adapter.setOptions({ mode: "plan" }); // deferred: the turn is still claimed
  await tick();
  assert.deepEqual(server.state.agents, [], "no switch while the turn runs");
  adapter.isTurnRunning = false; // the turn ended (bus would say so)
  adapter.handleEvent({ type: "session.next.step.ended", data: { sessionID: adapter.activeSessionId, finish: "stop", tokens: { input: 1 } } }); // production turn-end path
  await tick();
  assert.deepEqual(server.state.agents, [{ sessionId: "ses_new", agent: "plan" }]);
});

await test("an unknown mode switches nothing", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "auto");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  adapter.isTurnRunning = false;
  adapter.setOptions({ mode: "yolo" });
  await tick();
  assert.deepEqual(server.state.agents, []);
});

await test("a re-applied mode PATCHes nothing — no phantom 'Agent: build' row on resume", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "auto");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  adapter.isTurnRunning = false;
  adapter.setOptions({ mode: "auto" }); // resume re-applies the same mode
  await tick();
  assert.deepEqual(server.state.agents, [], "an agent the session already runs must not be PATCHed again");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
