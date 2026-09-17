// The turn folder's read model: what becomes a row, in what order, and what the
// collapsed bar counts.
//
// Order is the whole contract. A coding agent reads, edits, runs, reads again — an
// earlier revision of this screen grouped consecutive same-kind steps and it destroyed
// exactly that signal. These tests pin the flat, arrival-ordered line.
//
// Run: node --import ./test/loader-alias.mjs web/test/turnRows.test.mjs
import assert from "node:assert/strict";
import { buildTurnRows, visibleTools, splitTurnBlocks, hiddenCount, revealStep, collapseStep } from "../features/ai/lib/turnRows.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const seg = (id, extra = {}) => ({ id, role: "assistant", content: "", thinking: "", tools: [], diffs: [], ...extra });
const tool = (id, name, input = {}, extra = {}) => ({ id, name, input, status: "done", ...extra });

console.log("Running turnRows tests...");

test("segments flatten in arrival order — thought, tools, diff, text", () => {
  const rows = buildTurnRows([
    seg("a", { thinking: "look at the tests first" }),
    seg("b", { tools: [tool("t1", "Read", { file_path: "src/a.js" })] }),
    seg("c", { tools: [tool("t2", "Edit", { file_path: "src/a.js" })], diffs: [{ file: "src/a.js", patch: "+x" }] }),
    seg("d", { content: "done" })
  ], "claude");

  assert.deepEqual(rows.map((r) => r.kind), ["thought", "tool", "diff", "prose"]);
});

test("thinking keeps its place between tool batches, not hoisted to the top", () => {
  const rows = buildTurnRows([
    seg("a", { tools: [tool("t1", "Read", { file_path: "src/a.js" })] }),
    seg("b", { thinking: "now I see it" }),
    seg("c", { tools: [tool("t2", "Bash", { command: "npm test" })] })
  ], "claude");

  assert.deepEqual(rows.map((r) => r.kind), ["tool", "thought", "tool"]);
  assert.equal(rows[2].tool.name, "Bash");
});

test("an Edit already shown as a diff card is not also a tool row", () => {
  const tools = [tool("t1", "Edit", { file_path: "src/a.js" }), tool("t2", "Read", { file_path: "src/b.js" })];
  const out = visibleTools("claude", tools, [{ file: "src/a.js", patch: "+x" }]);
  assert.deepEqual(out.map((t) => t.id), ["t2"]);
});

test("an Edit with no matching diff card still gets a row", () => {
  const out = visibleTools("claude", [tool("t1", "Edit", { file_path: "src/a.js" })], []);
  assert.deepEqual(out.map((t) => t.id), ["t1"]);
});

test("a codex file_change is replaced by its diffs, one row per file", () => {
  // Codex names every file it touched on one call; each gets its own diff card, so the
  // row must go once any of them is on screen — but not before.
  const call = tool("t1", "file_change", { file_path: "src/a.js", path: "src/a.js", paths: ["src/a.js", "src/b.js"] });
  assert.deepEqual(visibleTools("codex", [call], [{ file: "src/a.js", patch: "+x" }]).map((t) => t.id), []);
  assert.deepEqual(visibleTools("codex", [call], []).map((t) => t.id), ["t1"]);
});

test("checklist tools stay out — the pinned strip already owns them", () => {
  const out = visibleTools("claude", [tool("t1", "TodoWrite", { todos: [] }), tool("t2", "Read", { file_path: "x" })], []);
  assert.deepEqual(out.map((t) => t.id), ["t2"]);
});

test("a running question is skipped; an answered one is a row", () => {
  const running = buildTurnRows([seg("a", { tools: [tool("q1", "AskUserQuestion", {}, { status: "running" })] })], "claude");
  assert.equal(running.length, 0);
  const answered = buildTurnRows([seg("a", { tools: [tool("q1", "AskUserQuestion", {}, { status: "done", output: "yes" })] })], "claude");
  assert.deepEqual(answered.map((r) => r.kind), ["tool"]);
});

test("prose is never hidden — only runs of steps are windowed", () => {
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "tool", id: `a${i}` })),
    { kind: "prose", id: "p1", content: "halfway" },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: "tool", id: `b${i}` })),
    { kind: "prose", id: "p2", content: "done" }
  ];
  const blocks = splitTurnBlocks(rows, 6);
  // steps, prose, steps, prose — prose ends a run, it is not swallowed by one
  assert.deepEqual(blocks.map((b) => b.type), ["steps", "row", "steps", "row"]);
  assert.equal(blocks[1].row.id, "p1");
  assert.equal(blocks[3].row.id, "p2");
});

test("a run reports how many steps it still hides, not how many it has", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ kind: "tool", id: `t${i}` }));
  const [block] = splitTurnBlocks(rows, 6);
  assert.equal(block.hidden, 6);
});

test("a short run gets no bar — opening it would cost more than it saves", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ kind: "tool", id: `t${i}` }));
  const [block] = splitTurnBlocks(rows, 6);
  assert.equal(block.hidden, 0);
});

test("windowed rows are the TAIL of the run, in order", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ kind: "tool", id: `t${i}` }));
  const [block] = splitTurnBlocks(rows, 6);
  const shown = block.rows.slice(block.hidden);
  assert.deepEqual(shown.map((r) => r.id), ["t4", "t5", "t6", "t7", "t8", "t9"]);
  // nothing reordered: the hidden head plus the shown tail is the original list
  assert.deepEqual([...block.rows.slice(0, block.hidden), ...shown].map((r) => r.id), rows.map((r) => r.id));
});

test("thoughts count as steps, so a think-run windows too", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ kind: "thought", id: `th${i}` }));
  const [block] = splitTurnBlocks(rows, 6);
  assert.equal(block.type, "steps");
  assert.equal(block.hidden, 3);
});

// A turn paged in from history is marked deferred so its cards mount collapsed — the
// flag has to survive the split, or the leaf cards never see it.
test("deferred reaches both block kinds", () => {
  const rows = [
    { kind: "tool", id: "t0" },
    { kind: "prose", id: "p0", content: "hi" }
  ];
  const [steps, prose] = splitTurnBlocks(rows, 6, { deferred: true });
  assert.equal(steps.deferred, true);
  assert.equal(prose.deferred, true);
});

// The window bar pages older steps in and must take them back out again: a long run of
// steps shows its tail, and "show less" is the only way back to the short view.
test("a short run hides nothing", () => {
  assert.equal(hiddenCount(3, 3), 0);
});

// One more than the window is still shown whole — a bar costs more than it saves.
test("hiddenCount keeps the window plus one", () => {
  assert.equal(hiddenCount(4, 3), 0);
  assert.equal(hiddenCount(5, 3), 2);
});

test("revealing pages in a chunk, never past what is hidden", () => {
  assert.equal(revealStep(20, 12), 12);
  assert.equal(revealStep(5, 12), 5);
});

test("revealed steps come off the hidden count", () => {
  assert.equal(hiddenCount(20, 3, 12), 5);
  assert.equal(hiddenCount(20, 3, 17), 0);
});

// "show less" is a decrement of `revealed`, so it gives back at most what was paged in.
test("collapsing gives back a chunk, never past zero", () => {
  assert.equal(collapseStep(15, 12), 12);
  assert.equal(collapseStep(5, 12), 5);
  assert.equal(collapseStep(0, 12), 0);
});

// The full round trip: reveal everything, then collapse back to the window.
test("reveal then collapse returns to the window", () => {
  let revealed = 0;
  for (let i = 0; i < 10; i++) revealed += revealStep(hiddenCount(20, 3, revealed), 12);
  assert.equal(hiddenCount(20, 3, revealed), 0);

  while (revealed > 0) revealed -= collapseStep(revealed, 12);
  assert.equal(revealed, 0);
  assert.equal(hiddenCount(20, 3, revealed), 17);
});

// A call id the pane holds twice is one event applied twice (a live copy the hydrate
// replayed) — React drew it as two children with one key. The first row is the record.
test("the same call id in two segments becomes one row, not a duplicate key", () => {
  const rows = buildTurnRows([
    seg("a", { tools: [tool("call_x", "Bash", { command: "ls" })] }),
    seg("b", { tools: [tool("call_x", "Bash", { command: "ls" })] })
  ], "claude");
  assert.equal(rows.filter((r) => r.kind === "tool").length, 1);
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

console.log(`\n${fail === 0 ? "✅ all passed" : "❌ FAILED"}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
