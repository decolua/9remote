// Antigravity's conversation history is rebuilt from the CLI's own compact
// transcript (brain/<id>/.system_generated/logs/transcript.jsonl). Its
// per-conversation SQLite file holds the same turns in an undocumented binary
// encoding — this fixture pins the JSONL shape the reader depends on.
// Run: node agent/test/antigravityTranscript.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

const { recoverFromAntigravityTranscript } = await import("../features/ai/transcript.js");

console.log("Running Antigravity transcript tests...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-agy-"));
process.env.ANTIGRAVITY_HOME = root;
const sessionId = "11111111-2222-3333-4444-555555555555";
const logsDir = path.join(root, "brain", sessionId, ".system_generated", "logs");
fs.mkdirSync(logsDir, { recursive: true });
fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), [
  { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nlist the files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>" },
  { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", thinking: "**Checking**\n\nNeed to list.", tool_calls: [{ name: "run_command", args: { CommandLine: "\"ls -la\"", Cwd: "\"/tmp\"" } }] },
  { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "The command exited with code 0.\nOutput:\nfile.txt\n" },
  { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "There is one file." }
].map((r) => JSON.stringify(r)).join("\n"));

const events = recoverFromAntigravityTranscript("/tmp", sessionId);

test("the prompt is replayed without the harness's own context blocks", () => {
  const user = events.find((e) => e.event === "user_message");
  assert.equal(user.data.text, "list the files");
});

test("thinking, the tool call and its result all replay", () => {
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes("thinking"));
  const call = events.find((e) => e.event === "tool_start");
  assert.equal(call.data.name, "run_command");
  // The transcript JSON-quotes every argument value; a card reading `command` needs it bare.
  assert.equal(call.data.input.command, "ls -la");
  const result = events.find((e) => e.event === "tool_result");
  assert.equal(result.data.id, call.data.id);
  assert.match(result.data.output, /file\.txt/);
});

test("every conversation ends with a turn_complete so the pane stops spinning", () => {
  assert.equal(events[events.length - 1].event, "turn_complete");
});

test("an unknown id yields null rather than throwing", () => {
  assert.equal(recoverFromAntigravityTranscript("/tmp", "no-such-conversation"), null);
});

test("a path-traversal id is rejected before it reaches the filesystem", () => {
  assert.equal(recoverFromAntigravityTranscript("/tmp", "../../etc/passwd"), null);
});

fs.rmSync(root, { recursive: true, force: true });
delete process.env.ANTIGRAVITY_HOME;

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
