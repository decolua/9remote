// pi transcript recovery: pi's session format v3 is omp's (pi owns that wire),
// so the recoverer is the same reader rooted at ~/.pi/agent/sessions.
// Run: node test/piTranscript.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME is rewritten before the module loads — the reader resolves per call.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pi-home-"));
process.env.HOME = sandbox;
const { recoverFromTranscript } = await import("../features/ai/transcript.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const dir = path.join(sandbox, ".pi", "agent", "sessions", "--tmp--");
fs.mkdirSync(dir, { recursive: true });
const sid = "01a0f721-d15d-7256-abfc-fbafc3fb3c40";
const file = path.join(dir, `2026-10-01T11-03-03-773Z_${sid}.jsonl`);
fs.writeFileSync(file, [
  JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-10-01T11:03:03.773Z", cwd: "/tmp" }),
  JSON.stringify({ type: "message", id: "e1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] } }),
  JSON.stringify({ type: "message", id: "e2", timestamp: "t", message: { role: "assistant", content: [
    { type: "thinking", thinking: "check auth flow" },
    { type: "toolCall", id: "tc1", name: "edit", arguments: { path: "/tmp/a.ts", edits: [{ oldText: "x", newText: "y" }] } }
  ] } }),
  JSON.stringify({ type: "message", id: "e3", timestamp: "t", message: { role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: "edited" }] } }),
  JSON.stringify({ type: "message", id: "e4", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })
].join("\n") + "\n");

console.log("Running pi transcript tests...");

test("a pi session replays text, thinking, tool rows and the edit diff", () => {
  const events = recoverFromTranscript("pi", "/tmp", sid);
  assert.ok(events, "no events recovered");
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes("user_message"), "user message recovered");
  assert.ok(kinds.includes("delta") || kinds.includes("assistant"), "assistant text recovered");
  assert.ok(kinds.includes("thinking"), "thinking recovered");
  assert.ok(kinds.some((k) => String(k).includes("tool")), "tool rows recovered");
});

test("a session from another project does not leak across", () => {
  assert.equal(recoverFromTranscript("pi", "/other/project", sid), null);
});

test("an unknown id recovers nothing", () => {
  assert.equal(recoverFromTranscript("pi", "/tmp", "01a00000-0000-0000-0000-000000000000"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
