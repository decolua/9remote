// omp transcript recovery against a synthetic session file (format measured
// from ~/.omp/agent/sessions on 18.2.6).
// Run: node agent/test/ompTranscript.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME is rewritten before the module loads — the reader resolves per call.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-omp-home-"));
process.env.HOME = sandbox;
const { recoverFromOmpTranscript } = await import("../features/ai/transcript.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const dir = path.join(sandbox, ".omp", "agent", "sessions", "--tmp--");
fs.mkdirSync(dir, { recursive: true });
const sid = "01a0bf61-0165-7504-bff4-1088da82003f";
const file = path.join(dir, `2026-09-20T15-13-20-741Z_${sid}.jsonl`);
fs.writeFileSync(file, [
  JSON.stringify({ type: "title", v: 1, title: "" }),
  JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-09-20T15:13:20.741Z", cwd: "/tmp" }),
  JSON.stringify({ type: "message", id: "e1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "add an export" }] } }),
  JSON.stringify({ type: "message", id: "e2", timestamp: "t", message: { role: "assistant", content: [
    { type: "thinking", thinking: "where to put it" },
    { type: "toolCall", id: "tc1", name: "write", arguments: { path: "/tmp/a.ts", content: "export {}\n" } }
  ] } }),
  JSON.stringify({ type: "message", id: "e3", timestamp: "t", message: { role: "toolResult", toolCallId: "tc1", toolName: "write", content: [{ type: "text", text: "written" }] } }),
  JSON.stringify({ type: "message", id: "e4", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })
].join("\n") + "\n");

console.log("Running omp transcript tests...");

test("a session replays text, thinking, tool rows and the write diff", () => {
  const events = recoverFromOmpTranscript("/tmp", sid);
  assert.ok(events, "no events recovered");
  const names = events.map((e) => e.event);
  assert.deepEqual(names, ["user_message", "thinking", "tool_start", "tool_result", "diff", "delta", "turn_complete"]);
  const diff = events.find((e) => e.event === "diff");
  assert.equal(diff.data.file, "/tmp/a.ts");
  assert.match(diff.data.content, /export \{\}/);
});

test("a failed tool result replays as an error card", () => {
  const sid2 = "ffffffff-0000-0000-0000-000000000001";
  fs.writeFileSync(path.join(dir, `2026-09-20T16-00-00-000Z_${sid2}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: sid2, cwd: "/tmp" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "ls" } }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t9", toolName: "bash", content: [{ type: "text", text: "nope" }], isError: true } })
  ].join("\n") + "\n");
  const events = recoverFromOmpTranscript("/tmp", sid2);
  const result = events.find((e) => e.event === "tool_result");
  assert.equal(result.data.status, "error");
  assert.match(result.data.error, /nope/);
  assert.ok(!events.some((e) => e.event === "diff"), "a failed write diff must not land");
});

test("an unknown id recovers nothing", () => {
  assert.equal(recoverFromOmpTranscript("/tmp", "nope"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
