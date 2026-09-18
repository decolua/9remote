// Token accounting per adapter: each host reports usage with its own semantics —
// claude and codex send session-running totals, opencode sends per-step deltas. Adding
// a cumulative total double-counts every earlier turn, so these pin which is which.
// Run: node agent/test/aiTokenStats.test.mjs
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI token stats tests...");

await test("claude reads this turn's usage from result.usage, not the zeroed assistant usage", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  // Shape verified against claude 2.1.270 stream-json: assistant.usage is all zeros,
  // and result.usage is the turn's own count.
  adapter.handleMessage({
    type: "assistant",
    message: { usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "hi" }] }
  });
  adapter.handleMessage({
    type: "result",
    usage: { input_tokens: 27032, output_tokens: 497, cache_read_input_tokens: 800, cache_creation_input_tokens: 20 },
    modelUsage: { "model-a": { inputTokens: 27032, outputTokens: 497, contextWindow: 1000000 } }
  });
  assert.equal(adapter.stats.inputTokens, 27032);
  assert.equal(adapter.stats.outputTokens, 497);
  assert.equal(adapter.stats.cacheReadInputTokens, 800);
  assert.equal(adapter.stats.contextWindow, 1000000);
});

await test("claude does not read modelUsage as the turn's own count — it is a session-running sum", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  // Measured on 2.1.270: turn 2 reported usage.input_tokens 26923 while modelUsage,
  // which accumulates every turn, said 53829. Reading modelUsage made the context
  // readout roughly double the real fill on the second turn of every conversation.
  adapter.handleMessage({
    type: "result",
    usage: { input_tokens: 26923, output_tokens: 3 },
    modelUsage: { m: { inputTokens: 53829, outputTokens: 6, contextWindow: 1000000 } }
  });
  assert.equal(adapter.stats.inputTokens, 26923);
  assert.equal(adapter.stats.outputTokens, 3);
});

await test("claude takes the window size from modelUsage, the only place it is stated", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  adapter.handleMessage({
    type: "result",
    usage: { input_tokens: 500 },
    modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } }
  });
  assert.equal(adapter.stats.contextWindow, 1000000, "the widest model can overflow the window");
});

await test("codex assigns its cumulative turn.completed usage and reads the real key names", () => {
  const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: () => {} });
  adapter.handleEvent({
    type: "turn.completed",
    usage: { input_tokens: 14162, cached_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 3 }
  });
  adapter.handleEvent({
    type: "turn.completed",
    usage: { input_tokens: 28339, cached_input_tokens: 13824, output_tokens: 12, reasoning_output_tokens: 4 }
  });
  assert.equal(adapter.stats.inputTokens, 28339);
  assert.equal(adapter.stats.outputTokens, 12);
  assert.equal(adapter.stats.cachedTokens, 13824);
  assert.equal(adapter.stats.reasoningTokens, 4);
});

await test("opencode keeps adding its per-step tokens", () => {
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: () => {} });
  // The serve bus bills a step on session.next.step.ended (recorded shape).
  const step = (tokens, finish = "stop") => ({
    type: "session.next.step.ended", data: { sessionID: "ses_1", finish, tokens }
  });
  adapter.handleEvent(step({ input: 10654, output: 55, reasoning: 0, cache: { read: 0, write: 0 } }, "tool-calls"));
  adapter.handleEvent(step({ input: 8918, output: 44, reasoning: 0, cache: { read: 0, write: 0 } }));
  assert.equal(adapter.stats.inputTokens, 19572);
  assert.equal(adapter.stats.outputTokens, 99);
});

await test("opencode's context is the LAST step's input, not the sum of every step", () => {
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: () => {} });
  const step = (tokens, finish = "stop") => ({
    type: "session.next.step.ended", data: { sessionID: "ses_1", finish, tokens }
  });
  adapter.handleEvent(step({ input: 10654, output: 55, reasoning: 0, cache: { read: 0, write: 0 } }, "tool-calls"));
  adapter.handleEvent(step({ input: 8918, output: 44, reasoning: 0, cache: { read: 0, write: 0 } }));
  // Each step resends the growing conversation, so the sum bills the same context
  // repeatedly — the window holds what the final step sent.
  assert.equal(adapter.stats.contextTokens, 8918);
});

await test("claude's context is the LAST step's input from the stream, not result.usage's sum", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  const step = (usage) => adapter.handleMessage({ type: "stream_event", event: { type: "message_delta", usage } });
  // Measured on 2.1.270: a three-step turn streamed input 26915 then 27656 while
  // result.usage said 54571 — the sum over every step, which overstates the window.
  step({ input_tokens: 26915, output_tokens: 220 });
  step({ input_tokens: 27656, output_tokens: 4 });
  assert.equal(adapter.stats.contextTokens, 27656);
  adapter.handleMessage({
    type: "result",
    usage: { input_tokens: 54571, output_tokens: 224 },
    modelUsage: { m: { contextWindow: 1000000 } }
  });
  assert.equal(adapter.stats.contextTokens, 27656, "the result event does not walk the fill back up");
  assert.equal(adapter.stats.inputTokens, 54571, "the billed total still comes from result.usage");
});

await test("claude's context counts both cache fields, the way the CLI resends them", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  adapter.handleMessage({
    type: "stream_event",
    event: { type: "message_delta", usage: { input_tokens: 900, cache_read_input_tokens: 44000, cache_creation_input_tokens: 600 } }
  });
  assert.equal(adapter.stats.contextTokens, 45500);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
