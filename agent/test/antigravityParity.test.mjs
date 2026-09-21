// Antigravity parity gaps: the result record's error state must reach
// turn_complete (isError) like claude's does, and denied_actions must surface
// as a readable warning row instead of living only in the blocked ladder.
// Run: node agent/test/antigravityParity.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "../features/ai/adapters/antigravityAdapter.js";
import { listAntigravityModelOptions } from "../features/ai/models.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

function makeAdapter() {
  const events = [];
  const adapter = new AntigravityAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  adapter._bind();
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

console.log("Running antigravity parity tests...");

await test("a failed result marks the turn's completion as an error", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({ event: "result", result: { status: "ERROR", error: "model quota exceeded", usage: {} } });
  adapter.proc.onExit({ code: 0 });
  assert.equal(of("error").length, 1);
  const [done] = of("turn_complete");
  assert.equal(done[1].isError, true);
});

await test("a clean result completes without the error flag", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({ event: "result", result: { status: "SUCCESS", usage: {} } });
  adapter.proc.onExit({ code: 0 });
  assert.equal(of("error").length, 0);
  assert.equal(of("turn_complete")[0][1].isError, false);
});

await test("denied actions become one warning row naming the tools", () => {
  const { adapter, of } = makeAdapter();
  adapter.handleEvent({
    event: "result",
    result: {
      status: "SUCCESS", usage: {},
      denied_actions: [
        { action: "write_file", display_name: "WriteToFile" },
        { action: "run_command", display_name: "RunCommand" }
      ]
    }
  });
  adapter.proc.onExit({ code: 0 });
  const warnings = of("cli_event").filter(([, d]) => d?.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1].record.message, /WriteToFile/);
  assert.match(warnings[0][1].record.message, /RunCommand/);
});

await test("a non-zero exit codes the turn as an error even without a result", () => {
  const { adapter, of } = makeAdapter();
  adapter.proc.onExit({ code: 3 });
  assert.equal(of("turn_complete")[0][1].isError, true);
});

await test("`agy models` becomes the host catalog", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
  fs.writeFileSync(
    path.join(bin, "agy"),
    "#!/bin/sh\nprintf 'Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-3.1-pro-low\\tGemini 3.1 Pro (Low)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)\\n'\n",
    { mode: 0o755 }
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const options = listAntigravityModelOptions();
    assert.deepEqual(options.map((o) => o.id), ["gemini-3.8-flash-high", "gemini-3.1-pro-low", "claude-sonnet-4-6"]);
    assert.deepEqual(options.map((o) => o.label), ["Gemini 3.8 Flash (High)", "Gemini 3.1 Pro (Low)", "Claude Sonnet 4.6 (Thinking)"]);
    assert.ok(options.every((o) => o.label && o.short));
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
