// Tests for the Antigravity (agy) adapter's stream-json normalization.
// Run: node agent/test/antigravityAdapter.test.mjs
import assert from "node:assert/strict";
import { AntigravityAdapter } from "../features/ai/adapters/antigravityAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// Collects the events an adapter emits while replaying recorded `agy` output lines.
function replay(lines, setup = () => {}) {
  const events = [];
  const adapter = new AntigravityAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  setup(adapter);
  for (const line of lines) adapter.handleEvent(JSON.parse(line));
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

const INIT = JSON.stringify({
  event: "init",
  conversation_id: "conv-1",
  init: { model: "gemini-3.8-flash-low", permission_mode: "request-review" }
});

const step = (o) => JSON.stringify({ event: "step_update", step_update: o });

console.log("Running Antigravity adapter tests...");

await test("registers agy as its own doctor command", () => {
  assert.deepEqual(AntigravityAdapter.doctorSpec(), { command: "agy", args: ["--version"] });
});

await test("attaches the prompt with = so it is not eaten by a following flag", () => {
  const { adapter } = replay([]);
  const args = adapter.buildArgs("hello world");
  assert.equal(args.at(-1), "-p=hello world");
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
});

await test("defaults to accept-edits, and plan mode replaces the bypass flag", () => {
  const { adapter } = replay([]);
  assert.ok(adapter.buildArgs("x").includes("--dangerously-skip-permissions"));

  adapter.setOptions({ mode: "plan" });
  const args = adapter.buildArgs("x");
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

await test("never sends --effort: the model id already carries its tier", () => {
  const { adapter } = replay([]);
  adapter.setOptions({ model: "gemini-3.8-flash-low", mode: "accept-edits" });
  assert.ok(!adapter.buildArgs("x").some((a) => a === "--effort" || a.startsWith("--effort=")));
});

await test("adopts the conversation id so the next turn can resume", () => {
  const { adapter, of } = replay([INIT]);
  assert.equal(adapter.activeConversationId, "conv-1");
  // Emitted as `sessionId`: that is the key aiSession reads to persist the id.
  assert.equal(of("init")[0][1].sessionId, "conv-1");
  assert.ok(adapter.buildArgs("x").includes("conv-1"));
});

await test("persists the conversation id on the session, so a reload can resume it", async () => {
  const { AiSession } = await import("../features/ai/aiSession.js");
  const s = new AiSession({ id: "antigravity-test", engine: "antigravity", cwd: "/tmp", options: {}, onEvent: () => {} });
  s.emitNormalized("init", { sessionId: "conv-xyz" });
  assert.equal(s.cliSessionId, "conv-xyz");
  assert.equal(s.metadata().sessionId, "conv-xyz");
});

await test("forwards every text_delta — the DONE event carries the reply's tail", () => {
  // Recorded from a real turn: the CLI cuts mid-word, so the DONE delta is not just a
  // newline. Keeping only ACTIVE deltas truncated this reply at "…successfu".
  const { of } = replay([
    INIT,
    step({ step_index: 0, state: "DONE", step_type: "user_input" }),
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { output_tokens: 750 } }),
    step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "I have successfu" }),
    step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "lly executed it.\n", usage: { output_tokens: 252 } })
  ]);
  assert.equal(of("delta").map(([, d]) => d.text).join(""), "I have successfully executed it.\n");
});

await test("pairs a tool start with its result under the same id", () => {
  const { of } = replay([
    INIT,
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { parameters: { DirectoryPath: "/tmp" } } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: { output: "a.txt" } })
  ]);
  const [start] = of("tool_start");
  const [result] = of("tool_result");
  assert.equal(start[1].id, result[1].id);
  assert.equal(result[1].output, "a.txt");
});

await test("a denied tool becomes an escalating blocked card, not a tool error", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 4,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { error: { type: "TOOL_ERROR", message: "permission check failed for command: user denied permission to run command" } }
    })
  ], (a) => a.setOptions({ mode: "plan" }));
  assert.equal(of("tool_result").length, 0);
  const [blocked] = of("blocked");
  assert.equal(blocked[1].engine, "antigravity");
  assert.equal(blocked[1].escalate.mode, "accept-edits");
});

await test("at the top of the ladder a denial has nothing to escalate to", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 4,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { error: { message: "permission check failed for command: user denied permission to run command" } }
    })
  ]);
  const [blocked] = of("blocked");
  assert.equal(blocked[1].escalate, undefined);
});

await test("a real tool failure stays a tool error", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 5,
      state: "ERROR",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: { error: { type: "TOOL_ERROR", message: "invalid_args: not a valid artifact path" } }
    })
  ]);
  assert.equal(of("blocked").length, 0);
  assert.equal(of("tool_result")[0][1].status, "error");
});

await test("counts usage once per turn — result.usage is cumulative, not a delta", () => {
  const { adapter, of } = replay([
    INIT,
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 13001, output_tokens: 2, thinking_tokens: 0 } }),
    JSON.stringify({
      event: "result",
      result: { conversation_id: "conv-1", status: "SUCCESS", response: "PONG\n", usage: { input_tokens: 13001, output_tokens: 2, thinking_tokens: 0 } }
    })
  ]);
  assert.equal(adapter.stats.outputTokens, 2);
  assert.equal(of("stats").at(-1)[1].stats.totalTurns, 1);
});

await test("totalTurns counts turns, not steps — a tool-using turn is still one", () => {
  const { adapter } = replay([
    INIT,
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { output_tokens: 10 } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: {} }),
    step({ step_index: 3, state: "DONE", step_type: "agent_response", usage: { output_tokens: 20 } }),
    step({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: {} }),
    step({ step_index: 5, state: "DONE", step_type: "agent_response", usage: { output_tokens: 30 } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS" } })
  ]);
  assert.equal(adapter.stats.totalTurns, 1);
  assert.equal(adapter.stats.outputTokens, 60);
});

await test("a non-SUCCESS result surfaces as an error", () => {
  const { of } = replay([INIT, JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exhausted" } })]);
  assert.equal(of("error")[0][1].message, "quota exhausted");
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
