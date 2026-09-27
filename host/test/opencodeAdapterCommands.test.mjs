// The '/' menu contract on the adapter: known opencode commands are executed via
// the server's command route, everything else (plain text, unknown slash) is a prompt.
// Run: node agent/test/opencodeAdapterCommands.test.mjs
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function fakeServer(commands = ["init", "review", "find-skills"]) {
  const state = { ran: [], prompted: [], patches: [] };
  return {
    state,
    listCommands: async () => commands.map((name) => ({ name, description: `desc ${name}`, source: "command" })),
    runCommand: async (sessionId, body) => { state.ran.push({ sessionId, body }); return { ok: true }; },
    createSession: async () => ({ id: "ses_new" }),
    prompt: async (sessionId, body) => { state.prompted.push({ sessionId, body }); },
    setSessionModel: async () => {},
    setSessionAgent: async (sessionId, agent) => { state.patches.push({ sessionId, agent }); },
    interruptSession: async () => {},
    activeSessions: async () => ({}),
    subscribeBus: () => ({ close() {} }),
  };
}

function makeAdapter(server) {
  const events = [];
  const adapter = new OpenCodeAdapter({
    cwd: "/tmp",
    onEvent: (e, d) => events.push([e, d]),
    server,
    model: "anthropic/claude-sonnet-5",
  });
  return { adapter, events };
}

console.log("Running opencode adapter command tests...");

await test("setOptions publishes the live command list on init", async () => {
  const { adapter, events } = makeAdapter(fakeServer());
  adapter.setOptions({});
  await tick();
  const init = events.filter(([e]) => e === "init").at(-1);
  assert.ok(init, "no init emitted");
  const names = (init[1].commands || []).map((c) => c.name);
  assert.deepEqual(names, ["init", "review", "find-skills"]);
  assert.equal(init[1].commands[0].description, "desc init");
});

await test("a known command runs through the command route, not the prompt", async () => {
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("/review pr");
  await tick();
  assert.equal(server.state.ran.length, 1);
  assert.equal(server.state.ran[0].body.command, "review");
  assert.equal(server.state.ran[0].body.arguments, "pr");
  assert.equal(server.state.ran[0].sessionId, "ses_new");
  assert.equal(server.state.prompted.length, 0, "command must not be sent as a prompt");
});

await test("a command with no args sends an empty arguments string", async () => {
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("/init");
  await tick();
  assert.equal(server.state.ran[0].body.arguments, "");
});

await test("unknown slash text and plain text stay prompts", async () => {
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("/not-a-command hello");
  await tick();
  assert.equal(server.state.ran.length, 0);
  assert.equal(server.state.prompted.length, 1);
  assert.equal(server.state.prompted[0].body.prompt.text, "/not-a-command hello");
});

await test("mid-text slash is never intercepted", async () => {
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("please run /init now");
  await tick();
  assert.equal(server.state.ran.length, 0);
  assert.equal(server.state.prompted.length, 1);
});

await test("the model rides the command body, the variant does not", async () => {
  // Same catalog rule as the model PATCH: no model here exposes a variant,
  // and an unknown variant can kill the runner's next step silently.
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("/review");
  await tick();
  assert.equal(server.state.ran[0].body.model, "anthropic/claude-sonnet-5");
  assert.equal(server.state.ran[0].body.variant, undefined, "variant must not ride the command body");
});

await test("a command sent while the list is still loading waits for it", async () => {
  // Cold-start race (audited): /cmd must not fall through to the LLM as text
  // just because the command list has not answered yet.
  let release;
  const gate = new Promise((r) => (release = r));
  const server = fakeServer();
  server.listCommands = () => gate.then(() => [{ name: "review", description: "", source: "command" }]);
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  adapter.sendPrompt("/review pr");
  release();
  await tick(30);
  assert.equal(server.state.ran.length, 1, "command must be intercepted after the list lands");
  assert.equal(server.state.prompted.length, 0);
});

await test("a resolved command turn reconciles even if the bus missed the events", async () => {
  // The command POST blocks until the whole agent loop ends, so its return is
  // itself an authoritative turn end (audited gap: SSE could have missed them).
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  server.activeSessions = async () => ({});
  adapter.sendPrompt("/review");
  await tick(30);
  assert.equal(server.state.ran.length, 1);
  assert.equal(adapter.isTurnRunning, false, "turn must settle once the command call returns and the engine is idle");
});

await test("a mode/model failure warns without ending the turn", async () => {
  // error events release the turn (aiStatus TURN_END_EVENTS) — a refused
  // agent/model switch must be a warning row, not a dead turn (audited).
  const server = fakeServer();
  server.setSessionAgent = async () => { throw new Error("route refused"); };
  const { adapter, events } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("first"); // session exists, then settles idle
  await tick(30);
  adapter.isTurnRunning = false; // the turn ended (bus would say so)
  events.length = 0;
  adapter.setOptions({ mode: "plan" }); // idle switch is refused by the route
  await tick(30);
  const warnings = events.filter(([e, d]) => e === "cli_event" && d?.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1].record.message, /mode/i);
  assert.equal(events.filter(([e]) => e === "error").length, 0);
});


await test("a fresh session is BORN with model+agent and never patches a switch", async () => {
  // Measured on 1.18.32: any setSessionModel/setSessionAgent while the first turn
  // is admitted or running can kill the run — a model PATCH with a variant the
  // model lacks (all catalog models here have none) fails the runner's next
  // step resolve BEFORE an event publisher exists, so no end-of-turn event ever
  // fires and the pane hangs. A fresh session carries its choices at creation.
  const calls = { created: null, patches: [] };
  const server = fakeServer();
  server.createSession = async (cwd, extras) => { calls.created = { cwd, extras }; return { id: "ses_new" }; };
  server.setSessionModel = async () => { calls.patches.push("model"); };
  server.setSessionAgent = async () => { calls.patches.push("agent"); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("hello");
  await tick(30);
  assert.deepEqual(calls.created.extras, {
    model: { id: "claude-sonnet-5", providerID: "anthropic" },
    agent: "build"
  });
  assert.deepEqual(calls.patches, [], "fresh flow must not PATCH model/agent at all");
  assert.equal(server.state.prompted.length, 1);
});

await test("a deferred switch drains fully before the next prompt, with no variant", async () => {
  const order = [];
  const bodies = [];
  const server = fakeServer();
  server.setSessionModel = async (sid, body) => { order.push("model"); bodies.push(body); };
  server.setSessionAgent = async () => { order.push("agent"); };
  server.prompt = async () => { order.push("prompt"); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("first");
  await tick(30);
  order.length = 0;
  // Turn settled without a bus event (SSE gap): the dirty switch survives.
  adapter.isTurnRunning = false;
  adapter.setOptions({ model: "anthropic/claude-opus-5" });
  adapter.isTurnRunning = false;
  adapter.sendPrompt("second");
  await tick(30);
  assert.deepEqual(order.slice(0, 2), ["model", "prompt"]);
  assert.deepEqual(bodies.at(-1), { id: "claude-opus-5", providerID: "anthropic" }, "variant must not ride the switch (catalog models have none)");
});

await test("model/mode chosen mid-run defer their switch until the turn ends, coalesced", async () => {
  // Mid-run PATCHes poison the runner's continuation (measured above); the
  // switch must land while the session is idle, i.e. right after turn_complete.
  const order = [];
  const bodies = [];
  const server = fakeServer();
  server.setSessionModel = async (sid, body) => { order.push("model"); bodies.push(body); };
  server.setSessionAgent = async () => { order.push("agent"); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("first");
  await tick(30);
  order.length = 0;
  adapter.isTurnRunning = true; // a turn is in flight
  adapter.setOptions({ model: "anthropic/claude-opus-5" });
  adapter.setOptions({ model: "anthropic/claude-haiku-4-5" });
  await tick(30);
  assert.deepEqual(order, [], "no switch may land while the turn runs");
  adapter.handleEvent({ type: "session.next.step.ended", data: { sessionID: adapter.activeSessionId, finish: "stop", tokens: { input: 1 } } });
  await tick(30);
  assert.equal(order.filter((x) => x === "model").length, 1, "rapid picks coalesce into one switch");
  assert.equal(bodies.at(-1).id, "claude-haiku-4-5", "the latest choice wins");
});

await test("a pick landing inside the create RTT is caught and drains later", async () => {
  // The birth body leaves before the pick arrives; without the catch the UI
  // shows the new model while the engine runs the old one forever.
  const order = [];
  const server = fakeServer();
  let release;
  const gate = new Promise((r) => (release = r));
  server.createSession = (cwd, extras) => gate.then(() => ({ id: "ses_new", born: extras }));
  server.setSessionModel = async (sid, body) => { order.push(["model", body.id]); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  adapter.sendPrompt("hello");
  await tick(1); // the create request has left; the pick lands inside the RTT
  adapter.setOptions({ model: "anthropic/claude-opus-5" });
  release();
  await tick(40);
  assert.equal(order.length, 0, "no PATCH around the first turn's admission");
  adapter.handleEvent({ type: "session.next.step.ended", data: { sessionID: adapter.activeSessionId, finish: "stop", tokens: { input: 1 } } });
  await tick(40);
  assert.deepEqual(order, [["model", "claude-opus-5"]], "the raced pick lands at turn end");
});

await test("a prompt waits for an in-flight switch pass before it leaves", async () => {
  // sendPrompt's force drain piggybacks onto a running pass — the force must
  // survive the piggyback or the prompt can outrun the PATCH.
  const order = [];
  const server = fakeServer();
  server.setSessionModel = async () => { await tick(30); order.push("model"); };
  server.prompt = async () => { order.push("prompt"); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("first");
  await tick(40);
  order.length = 0;
  adapter.isTurnRunning = false;
  adapter.setOptions({ model: "anthropic/claude-opus-5" }); // starts a slow pass
  await tick(5);
  adapter.sendPrompt("second"); // force drain must join the running pass
  await tick(80);
  assert.deepEqual(order, ["model", "prompt"]);
});

await test("the engine's own model report does not clobber a pending pick", async () => {
  const applied = [];
  const server = fakeServer();
  server.setSessionModel = async (sid, body) => { applied.push(body.id); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("first");
  await tick(30);
  adapter.isTurnRunning = true;
  adapter.setOptions({ model: "anthropic/claude-opus-5" }); // deferred pick
  adapter._ensureBus();
  adapter.bus = null; // let _ensureBus re-subscribe against the fake
  adapter.handleEvent({ type: "session.next.step.started", data: { sessionID: adapter.activeSessionId, model: { id: "other-model", providerID: "opencode" } } });
  assert.equal(adapter.currentModel, "anthropic/claude-opus-5", "a pending pick outranks the running turn's model");
  adapter.handleEvent({ type: "session.next.step.ended", data: { sessionID: adapter.activeSessionId, finish: "stop", tokens: { input: 1 } } });
  await tick(30);
  assert.deepEqual(applied, ["claude-opus-5"]);
});

await test("no phantom turn_complete while the prompt POST is still in flight", async () => {
  const events = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const server = fakeServer();
  server.prompt = () => gate.then(() => {});
  const adapter = new OpenCodeAdapter({
    cwd: "/tmp",
    onEvent: (e) => events.push(e),
    server,
    model: "anthropic/claude-sonnet-5"
  });
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("hello");
  adapter._reconcileTurn(); // an SSE reconnect fires here
  await tick(30);
  assert.ok(!events.includes("turn_complete"), "a not-yet-admitted prompt must not settle");
  assert.equal(adapter.isTurnRunning, true, "the double-prompt guard holds");
  release();
  await tick(30);
});

await test("a rebuilt adapter verifies upstream idle before its first switch", async () => {
  const applied = [];
  const server = fakeServer();
  server.setSessionModel = async (sid, body) => { applied.push(body.id); };
  let upstream = "busy";
  server.activeSessions = async () => (upstream === "busy" ? { ses_r: { type: "running" } } : {});
  const adapter = new OpenCodeAdapter({
    cwd: "/tmp",
    onEvent: () => {},
    server,
    proc: { attach: async () => ({}) },
    sessionId: "ses_r",
    model: "anthropic/claude-sonnet-5"
  });
  adapter.setOptions({ model: "anthropic/claude-opus-5" }); // rebuild: local idle
  await tick(30);
  assert.deepEqual(applied, [], "a live upstream turn must not see a PATCH");
  upstream = "idle";
  await adapter.adopt();
  adapter.isTurnRunning = false;
  adapter.handleEvent({ type: "session.next.step.ended", data: { sessionID: "ses_r", finish: "stop", tokens: { input: 1 } } });
  await tick(30);
  assert.deepEqual(applied, ["claude-opus-5"], "the pick lands once upstream is known idle");
});

await test("a slash command counts as a run: the next prompt drains first", async () => {
  const order = [];
  const server = fakeServer();
  server.setSessionModel = async () => { order.push("model"); };
  server.prompt = async () => { order.push("prompt"); };
  const { adapter } = makeAdapter(server);
  adapter.setOptions({ mode: "auto" });
  await tick();
  adapter.sendPrompt("/review"); // command-first session
  await tick(30);
  order.length = 0;
  adapter.isTurnRunning = false;
  adapter.setOptions({ model: "anthropic/claude-opus-5" });
  adapter.isTurnRunning = false;
  adapter.sendPrompt("hello");
  await tick(30);
  assert.deepEqual(order.slice(0, 2), ["model", "prompt"], "command turns unlock the pre-prompt drain");
});

await test("the first prompt names the session once (serve never auto-titles)", async () => {
  const { adapter, events } = makeAdapter(fakeServer());
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("fix the login bug\nsecond line ignored");
  await tick(30);
  const named = events.filter(([e, d]) => e === "init" && d?.threadName).map(([, d]) => d.threadName);
  assert.deepEqual(named, ["fix the login bug"]);
  adapter.isTurnRunning = false;
  adapter.sendPrompt("a second different prompt");
  await tick(30);
  const again = events.filter(([e, d]) => e === "init" && d?.threadName).map(([, d]) => d.threadName);
  assert.deepEqual(again, ["fix the login bug"], "the title is per engine session, not per prompt");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
