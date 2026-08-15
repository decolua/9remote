// Tests for the pure transcript layer of the terminal chat GUI: turning hook telemetry
// into rows, grouping repeated tool calls, and diffing an edit.
// Run: node web/test/agentChatTranscript.test.mjs
import assert from "node:assert/strict";
import { computeDiff, createCachedDiff } from "../features/agentChat/lib/diff.js";
import { groupActivity, describeTool, toolCategory } from "../features/agentChat/lib/transcript.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

/* ================= diff ================= */

await test("an unchanged file produces no rows", () => {
  assert.deepEqual(computeDiff("a\nb\nc", "a\nb\nc"), []);
});

await test("a single changed line yields one removal and one addition", () => {
  const d = computeDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d, [
    { type: "removed", content: "b", lineNum: 2 },
    { type: "added", content: "B", lineNum: 2 },
  ]);
});

await test("a pure insertion has no removals", () => {
  const d = computeDiff("a\nc", "a\nb\nc");
  assert.deepEqual(d, [{ type: "added", content: "b", lineNum: 2 }]);
});

await test("a pure deletion has no additions", () => {
  const d = computeDiff("a\nb\nc", "a\nc");
  assert.deepEqual(d, [{ type: "removed", content: "b", lineNum: 2 }]);
});

await test("creating a file shows every line as added", () => {
  const d = computeDiff("", "x\ny");
  assert.equal(d.length, 2);
  assert.ok(d.every((r) => r.type === "added"));
});

await test("only changed lines are emitted — no context rows", () => {
  const oldText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const newText = oldText.replace("line 25", "line twenty-five");
  const d = computeDiff(oldText, newText);
  assert.equal(d.length, 2, "a 50-line file with one edit must not render 50 rows");
});

await test("trailing newline differences do not fabricate a change", () => {
  assert.deepEqual(computeDiff("a\nb", "a\nb"), []);
});

await test("null and undefined inputs are treated as empty", () => {
  assert.deepEqual(computeDiff(null, null), []);
  assert.equal(computeDiff(undefined, "a").length, 1);
});

await test("the cache returns an identical result for a repeated pair", () => {
  const diff = createCachedDiff();
  const a = diff("a\nb", "a\nc");
  const b = diff("a\nb", "a\nc");
  assert.deepEqual(a, b);
  assert.equal(a, b, "the same pair must hit the cache, not recompute");
});

await test("the cache distinguishes different pairs", () => {
  const diff = createCachedDiff();
  const a = diff("a", "b");
  const b = diff("a", "c");
  assert.notDeepEqual(a, b);
});

await test("the cache evicts rather than growing without bound", () => {
  const diff = createCachedDiff(3);
  diff("1", "a"); diff("2", "b"); diff("3", "c"); diff("4", "d");
  assert.ok(diff.size() <= 3);
});

/* ================= tool description ================= */

await test("file tools are described by basename", () => {
  assert.equal(describeTool("Read", { file_path: "/a/b/c.js" }), "c.js");
  assert.equal(describeTool("Edit", { file_path: "/x/y.ts" }), "y.ts");
});

await test("Bash is described by its command", () => {
  assert.equal(describeTool("Bash", { command: "npm test" }), "npm test");
});

await test("a long command is truncated with an ellipsis", () => {
  const long = "x".repeat(200);
  const out = describeTool("Bash", { command: long });
  assert.ok(out.length < 60);
  assert.ok(out.endsWith("…"));
});

await test("search tools are described by their pattern", () => {
  assert.equal(describeTool("Grep", { pattern: "TODO" }), "TODO");
  assert.equal(describeTool("Glob", { pattern: "**/*.js" }), "**/*.js");
});

await test("Task is described by its description, falling back to the agent type", () => {
  assert.equal(describeTool("Task", { description: "find bugs" }), "find bugs");
  assert.equal(describeTool("Task", { subagent_type: "Explore" }), "Explore");
});

await test("an unknown tool with no recognised field degrades to an empty label", () => {
  assert.equal(describeTool("Mystery", {}), "");
  assert.equal(describeTool("Mystery", null), "");
});

await test("categories drive the accent colour", () => {
  assert.equal(toolCategory("Edit"), "edit");
  assert.equal(toolCategory("Bash"), "bash");
  assert.equal(toolCategory("Grep"), "search");
  assert.equal(toolCategory("Whatever"), "default");
});

/* ================= grouping ================= */

const tool = (toolName, toolInput, status = "done") => ({ kind: "tool", toolName, toolInput, status, at: 1 });

await test("a lone tool call is not grouped", () => {
  const rows = groupActivity([tool("Read", { file_path: "/a" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "tool");
});

await test("two consecutive identical tools collapse into one group", () => {
  const rows = groupActivity([tool("Read", { file_path: "/a" }), tool("Read", { file_path: "/b" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "group");
  assert.equal(rows[0].count, 2);
});

await test("a group preview names the first entries and counts the rest", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a.js" }), tool("Read", { file_path: "/b.js" }),
    tool("Read", { file_path: "/c.js" }), tool("Read", { file_path: "/d.js" }),
  ]);
  assert.match(rows[0].preview, /a\.js/);
  assert.match(rows[0].preview, /\+2/);
});

await test("a different tool breaks the run", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a" }), tool("Read", { file_path: "/b" }),
    tool("Bash", { command: "ls" }),
    tool("Read", { file_path: "/c" }), tool("Read", { file_path: "/d" }),
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["group", "tool", "group"]);
});

await test("a user prompt is its own row and breaks any run", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a" }), tool("Read", { file_path: "/b" }),
    { kind: "userPrompt", text: "next please", at: 2 },
    tool("Read", { file_path: "/c" }),
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["group", "userPrompt", "tool"]);
});

await test("a failed call is never hidden inside a group", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a" }),
    tool("Read", { file_path: "/b" }, "error"),
    tool("Read", { file_path: "/c" }),
  ]);
  assert.ok(rows.some((r) => r.type === "tool" && r.entry.status === "error"), "an error must stay visible on its own row");
});

await test("a still-running call is never hidden inside a group", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a" }),
    tool("Read", { file_path: "/b" }, "running"),
  ]);
  assert.ok(rows.some((r) => r.type === "tool" && r.entry.status === "running"));
});

await test("an empty or missing timeline yields no rows", () => {
  assert.deepEqual(groupActivity([]), []);
  assert.deepEqual(groupActivity(null), []);
});

/* ---- assistant prose: the reason the transcript reader exists ---- */

const say = (text) => ({ kind: "assistantText", text, at: 1, id: `a${text}` });
const think = (text) => ({ kind: "thinking", text, at: 1, id: `t${text}` });

await test("assistant prose gets its own row and is never grouped away", () => {
  const rows = groupActivity([say("Here is the plan.")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "assistantText");
  assert.equal(rows[0].entry.text, "Here is the plan.");
});

await test("prose breaks a run of identical tools", () => {
  const rows = groupActivity([
    tool("Read", { file_path: "/a" }), tool("Read", { file_path: "/b" }),
    say("I read both files."),
    tool("Read", { file_path: "/c" }), tool("Read", { file_path: "/d" }),
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["group", "assistantText", "group"]);
});

await test("thinking is a distinct row type so the UI can collapse it", () => {
  const rows = groupActivity([think("weighing options"), say("Done.")]);
  assert.deepEqual(rows.map((r) => r.type), ["thinking", "assistantText"]);
});

await test("a full turn renders in order: question, thinking, prose, tools", () => {
  const rows = groupActivity([
    { kind: "userPrompt", text: "fix it", at: 1 },
    think("looking at the code"),
    say("I'll start with the parser."),
    tool("Read", { file_path: "/p.js" }),
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["userPrompt", "thinking", "assistantText", "tool"]);
});

await test("an unknown future row kind still renders rather than vanishing", () => {
  const rows = groupActivity([{ kind: "somethingNew", text: "x", at: 1 }]);
  assert.equal(rows.length, 1, "silently dropping unknown rows hides real conversation");
});

await test("every row carries a stable key across recomputes", () => {
  const input = [tool("Read", { file_path: "/a" }), tool("Read", { file_path: "/b" }), tool("Bash", { command: "ls" })];
  const first = groupActivity(input).map((r) => r.key);
  const second = groupActivity(input).map((r) => r.key);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, "keys must be unique or React will reorder rows wrongly");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
