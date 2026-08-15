// Tests for reading a Claude transcript (.jsonl) into chat rows.
// Hooks report tool CALLS but never the assistant's prose — this reader is where the
// actual conversation comes from.
// Run: node agent/test/transcriptReader.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseTranscriptLines, readTranscript } = await import("../features/agentChat/transcriptReader.js");

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-transcript-"));
const write = (name, records) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return p;
};

const assistant = (blocks, extra = {}) => ({
  type: "assistant", uuid: `a${Math.random()}`, timestamp: "2026-01-01T00:00:00Z",
  message: { role: "assistant", content: blocks }, ...extra,
});
const user = (content, extra = {}) => ({
  type: "user", uuid: `u${Math.random()}`, timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content }, ...extra,
});

/* ================= the point of the whole feature ================= */

await test("assistant prose becomes a text row", () => {
  const rows = parseTranscriptLines([assistant([{ type: "text", text: "Here is what I found." }])]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "assistantText");
  assert.equal(rows[0].text, "Here is what I found.");
});

await test("a real user turn becomes a user row", () => {
  const rows = parseTranscriptLines([user("fix the login bug")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "userPrompt");
  assert.equal(rows[0].text, "fix the login bug");
});

await test("user content given as blocks is joined into one row", () => {
  const rows = parseTranscriptLines([user([{ type: "text", text: "part one" }, { type: "text", text: "part two" }])]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /part one/);
  assert.match(rows[0].text, /part two/);
});

await test("several text blocks in one assistant message stay in order", () => {
  const rows = parseTranscriptLines([assistant([
    { type: "text", text: "first" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
    { type: "text", text: "second" },
  ])]);
  assert.deepEqual(rows.map((r) => r.kind), ["assistantText", "tool", "assistantText"]);
  assert.equal(rows[0].text, "first");
  assert.equal(rows[2].text, "second");
});

/* ================= what must NOT show up ================= */

await test("harness-injected meta turns are not shown as user messages", () => {
  const rows = parseTranscriptLines([
    user("<local-command-caveat>ignore this</local-command-caveat>", { isMeta: true }),
    user("a real question"),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "a real question");
});

await test("system-reminder wrappers are not user messages", () => {
  const rows = parseTranscriptLines([user("<system-reminder>background context</system-reminder>")]);
  assert.equal(rows.length, 0, "the user never typed this — showing it would be a lie about the conversation");
});

await test("subagent traffic is excluded from the main thread", () => {
  const rows = parseTranscriptLines([
    assistant([{ type: "text", text: "main thread" }]),
    assistant([{ type: "text", text: "inside a subagent" }], { isSidechain: true }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "main thread");
});

await test("tool results are not rendered as user messages", () => {
  const rows = parseTranscriptLines([
    user([{ type: "tool_result", tool_use_id: "t1", content: "file contents here" }]),
  ]);
  assert.equal(rows.filter((r) => r.kind === "userPrompt").length, 0);
});

await test("non-conversation record types are skipped", () => {
  const rows = parseTranscriptLines([
    { type: "file-history-snapshot", data: {} },
    { type: "mode", mode: "plan" },
    { type: "ai-title", title: "x" },
    { type: "queue-operation" },
    assistant([{ type: "text", text: "kept" }]),
  ]);
  assert.equal(rows.length, 1);
});

/* ================= thinking ================= */

await test("thinking is captured but marked so the UI can hide it", () => {
  const rows = parseTranscriptLines([assistant([{ type: "thinking", thinking: "let me consider" }])]);
  assert.equal(rows[0].kind, "thinking");
  assert.equal(rows[0].text, "let me consider");
});

await test("empty text blocks are dropped", () => {
  const rows = parseTranscriptLines([assistant([{ type: "text", text: "   " }, { type: "text", text: "" }])]);
  assert.equal(rows.length, 0);
});

/* ================= tool calls, paired with their results ================= */

await test("a tool_use row carries its name and input", () => {
  const rows = parseTranscriptLines([assistant([
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
  ])]);
  assert.equal(rows[0].kind, "tool");
  assert.equal(rows[0].toolName, "Bash");
  assert.equal(rows[0].toolInput.command, "ls -la");
  assert.equal(rows[0].status, "running", "no result yet");
});

await test("a later tool_result completes the matching call", () => {
  const rows = parseTranscriptLines([
    assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "the file body" }]),
  ]);
  const tool = rows.find((r) => r.kind === "tool");
  assert.equal(tool.status, "done");
  assert.equal(tool.toolResponse, "the file body");
});

await test("an errored tool_result marks the call as failed", () => {
  const rows = parseTranscriptLines([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }]),
  ]);
  assert.equal(rows.find((r) => r.kind === "tool").status, "error");
});

await test("tool_result content given as blocks is flattened to text", () => {
  const rows = parseTranscriptLines([
    assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "block form" }] }]),
  ]);
  assert.equal(rows.find((r) => r.kind === "tool").toolResponse, "block form");
});

await test("a result with no matching call does not crash or invent a row", () => {
  const rows = parseTranscriptLines([user([{ type: "tool_result", tool_use_id: "unknown", content: "x" }])]);
  assert.equal(rows.length, 0);
});

/* ================= robustness: this file is written by another process ================= */

await test("a truncated final line is ignored, not fatal", () => {
  const rows = parseTranscriptLines([
    assistant([{ type: "text", text: "complete" }]),
    '{"type":"assistant","message":{"content":[{"type":"te',   // mid-write
  ]);
  assert.equal(rows.length, 1);
});

await test("blank lines and junk are skipped", () => {
  const rows = parseTranscriptLines(["", "   ", "not json at all", assistant([{ type: "text", text: "ok" }])]);
  assert.equal(rows.length, 1);
});

await test("a record with no message field is skipped", () => {
  const rows = parseTranscriptLines([{ type: "assistant" }, { type: "user", message: {} }]);
  assert.equal(rows.length, 0);
});

/* ================= reading from disk ================= */

await test("reads a file and returns rows oldest-first", () => {
  const p = write("a.jsonl", [
    user("first question"),
    assistant([{ type: "text", text: "first answer" }]),
    user("second question"),
  ]);
  const { rows } = readTranscript(p);
  assert.deepEqual(rows.map((r) => r.text), ["first question", "first answer", "second question"]);
});

await test("a missing file yields no rows instead of throwing", () => {
  const { rows } = readTranscript(path.join(tmp, "nope.jsonl"));
  assert.deepEqual(rows, []);
});

await test("only the tail is kept for a very long conversation", () => {
  const many = [];
  for (let i = 0; i < 500; i++) many.push(assistant([{ type: "text", text: `msg ${i}` }]));
  const p = write("long.jsonl", many);
  const { rows } = readTranscript(p, { maxRows: 100 });
  assert.equal(rows.length, 100);
  assert.equal(rows[rows.length - 1].text, "msg 499", "the newest turns are the ones worth keeping");
});

await test("reading twice from an unchanged file gives the same rows", () => {
  const p = write("stable.jsonl", [assistant([{ type: "text", text: "same" }])]);
  assert.deepEqual(readTranscript(p).rows, readTranscript(p).rows);
});

await test("rows carry a stable id so the UI can key them", () => {
  const p = write("ids.jsonl", [
    user("q"),
    assistant([{ type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "Read", input: {} }]),
  ]);
  const ids = readTranscript(p).rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate keys make React reorder rows wrongly");
  assert.ok(ids.every(Boolean));
});

/* ================= against the real thing ================= */

const REAL = "/Users/hoanganh/.claude/projects/-Users-Working-9remote/6c398afc-ceb0-41ac-a714-726cefec1b93.jsonl";
if (fs.existsSync(REAL)) {
  await test("parses this very conversation's transcript", () => {
    const { rows } = readTranscript(REAL, { maxRows: 400 });
    const kinds = new Set(rows.map((r) => r.kind));
    assert.ok(rows.length > 0);
    assert.ok(kinds.has("assistantText"), "assistant prose is the whole reason this reader exists");
    assert.ok(kinds.has("userPrompt"), "user turns must survive the meta filtering");
    assert.ok(kinds.has("tool"));
    // Nothing that reads as harness plumbing should reach the chat view.
    const leaked = rows.filter((r) => r.kind === "userPrompt" && /^<(system-reminder|local-command|command-name)/.test(r.text));
    assert.equal(leaked.length, 0, `harness text leaked into ${leaked.length} user rows`);
  });
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
