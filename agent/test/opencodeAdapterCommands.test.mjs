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

await test("model and variant ride the command body when set", async () => {
  const server = fakeServer();
  const { adapter } = makeAdapter(server);
  adapter.setOptions({});
  await tick();
  adapter.sendPrompt("/review");
  await tick();
  assert.equal(server.state.ran[0].body.model, "anthropic/claude-sonnet-5");
  assert.ok(server.state.ran[0].body.variant, "variant must ride the body");
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
  adapter.activeSessionId = "ses_new";
  adapter.isTurnRunning = true;
  adapter.setOptions({ mode: "plan" });
  await tick(30);
  const warnings = events.filter(([e, d]) => e === "cli_event" && d?.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1].record.message, /mode/i);
  assert.equal(events.filter(([e]) => e === "error").length, 0);
  assert.equal(adapter.isTurnRunning, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
