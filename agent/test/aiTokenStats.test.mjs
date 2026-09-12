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

await test("claude reads the session totals from result.modelUsage, not the zeroed assistant usage", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  // Shape verified against claude 2.1.269 stream-json: assistant.usage is all zeros,
  // the real counts ride on result.modelUsage keyed by model.
  adapter.handleMessage({
    type: "assistant",
    message: { usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "hi" }] }
  });
  adapter.handleMessage({
    type: "result",
    modelUsage: {
      "model-a": { inputTokens: 27032, outputTokens: 11 },
      "model-b": { inputTokens: 3089, outputTokens: 486 }
    }
  });
  assert.equal(adapter.stats.inputTokens, 30121);
  assert.equal(adapter.stats.outputTokens, 497);
});

await test("claude assigns rather than adds, so a second turn does not re-count the first", () => {
  const adapter = new ClaudeAdapter({ cwd: "/tmp", onEvent: () => {} });
  adapter.handleMessage({ type: "result", modelUsage: { m: { inputTokens: 100, outputTokens: 5 } } });
  adapter.handleMessage({ type: "result", modelUsage: { m: { inputTokens: 250, outputTokens: 9 } } });
  assert.equal(adapter.stats.inputTokens, 250);
  assert.equal(adapter.stats.outputTokens, 9);
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
  const step = (tokens) => ({ type: "step_finish", part: { tokens } });
  adapter.handleEvent(step({ input: 10654, output: 55 }));
  adapter.handleEvent(step({ input: 8918, output: 44 }));
  assert.equal(adapter.stats.inputTokens, 19572);
  assert.equal(adapter.stats.outputTokens, 99);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
