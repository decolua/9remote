// The live turn line's read model: what verb and detail the tail row shows while the
// agent works. Pinned here because every branch is a wording decision that is easy to
// break silently — the pane would still render, just with the wrong sentence.
//
// Run: node --import ./test/loader-alias.mjs web/test/liveStatus.test.mjs
import assert from "node:assert/strict";
import { describeLive, estimateTurnTokens, countTurnChanges, contextUsedTokens, formatTokens } from "../features/ai/lib/liveStatus.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const tool = (name, input = {}, extra = {}) => ({ id: "t1", name, input, status: "running", ...extra });

test("no carrier wins over everything else", () => {
  const r = describeLive({ connected: false, hydrating: true, activeTool: tool("Bash", { command: "ls" }) });
  assert.equal(r.verb, "Reconnecting");
  assert.equal(r.tone, "alert");
});

test("reconnect detail carries the attempt counter", () => {
  const r = describeLive({ connected: false, retryStatus: { isRetrying: true, attempt: 3, maxAttempts: 10 } });
  assert.equal(r.detail, "attempt 3/10");
});

test("a failed retry says so", () => {
  const r = describeLive({ connected: false, retryStatus: { isRetrying: true, attempt: 10, maxAttempts: 10, failed: true } });
  assert.match(r.detail, /gave up/);
});

test("hydrating outranks a running tool", () => {
  assert.equal(describeLive({ hydrating: true, activeTool: tool("Bash", { command: "ls" }) }).verb, "Syncing");
});

test("bash shows the command", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Bash", { command: "npm run test" }) });
  assert.equal(r.verb, "Running");
  assert.equal(r.detail, "npm run test");
});

test("Read shows the file name, not the whole path", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Read", { file_path: "/Users/x/proj/src/deep/thing.js" }) });
  assert.equal(r.verb, "Reading");
  assert.equal(r.detail, "thing.js");
});

test("Read with an offset points at the line", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Read", { file_path: "/a/b.js", offset: 120 }) });
  assert.equal(r.detail, "b.js:L120");
});

test("Edit reads as editing, not reading", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Edit", { file_path: "/a/b.js" }) });
  assert.equal(r.verb, "Editing");
  assert.equal(r.detail, "b.js");
});

test("Write reads as writing", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Write", { file_path: "/a/new.js" }) });
  assert.equal(r.verb, "Writing");
});

test("search quotes the pattern", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Grep", { pattern: "describeLive", path: "/a/lib" }) });
  assert.equal(r.verb, "Searching");
  assert.equal(r.detail, '"describeLive" in lib');
});

test("a web search shows its query", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("WebSearch", { query: "overflow-wrap anywhere" }) });
  assert.equal(r.verb, "Searching");
  assert.equal(r.detail, "overflow-wrap anywhere");
});

test("a web fetch shows its url", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("WebFetch", { url: "https://example.com/docs" }) });
  assert.equal(r.verb, "Searching");
  assert.equal(r.detail, "https://example.com/docs");
});

test("a sub-agent counts its steps", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Agent", { description: "audit the parser" }, { children: [{}, {}] }) });
  assert.equal(r.verb, "Delegating");
  assert.equal(r.detail, "audit the parser · 2 steps");
});

test("a tool the registry does not know falls back to Calling", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("mcp__github__create_issue", { name: "bug" }) });
  assert.equal(r.verb, "Calling");
  assert.equal(r.detail, "create_issue bug");
});

test("a generic tool with no argument shows only its name", () => {
  const r = describeLive({ engine: "antigravity", activeTool: tool("browser_resize_window", {}) });
  assert.equal(r.verb, "Calling");
  assert.equal(r.detail, "browser_resize_window");
});

test("an mcp tool drops its server prefix", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("mcp__github__create_issue", { name: "bug" }) });
  assert.equal(r.detail, "create_issue bug");
});

test("thinking beats content while it streams", () => {
  const r = describeLive({ lastMsg: { thinking: "first\nsecond thought", content: "hello" } });
  assert.equal(r.verb, "Thinking");
  assert.equal(r.detail, "second thought");
});

test("content alone reads as writing", () => {
  const r = describeLive({ lastMsg: { thinking: "", content: "line one\nline two" } });
  assert.equal(r.verb, "Writing");
  assert.equal(r.detail, "line two");
});

test("idle-but-running with nothing yet says Working", () => {
  const r = describeLive({ lastMsg: { thinking: "", content: "" } });
  assert.equal(r.verb, "Working");
  assert.equal(r.detail, "");
});

test("a long detail is clipped, not wrapped", () => {
  const r = describeLive({ engine: "claude", activeTool: tool("Bash", { command: "x".repeat(200) }) });
  assert.equal(r.detail.length, 60);
  assert.ok(r.detail.endsWith("…"));
});

// --- token estimate ---------------------------------------------------------

const msg = (role, extra = {}) => ({ role, content: "", thinking: "", ...extra });

test("tokens count the whole turn, not just the last message", () => {
  // A tool call closes the streaming segment, so the tail is empty here — reading only
  // the last message used to report 0 and the counter fell back to the host's number.
  const messages = [
    msg("user", { content: "do it" }),
    msg("assistant", { content: "a".repeat(400) }),
    msg("assistant", { content: "", tools: [tool("Bash", { command: "ls" })] })
  ];
  assert.equal(estimateTurnTokens(messages), 100);
});

test("thinking counts toward the estimate too", () => {
  const messages = [msg("user"), msg("assistant", { thinking: "b".repeat(200) })];
  assert.equal(estimateTurnTokens(messages), 50);
});

test("earlier turns are not counted", () => {
  const messages = [
    msg("assistant", { content: "x".repeat(4000) }),
    msg("user"),
    msg("assistant", { content: "c".repeat(40) })
  ];
  assert.equal(estimateTurnTokens(messages), 10);
});

test("an empty turn estimates zero", () => {
  assert.equal(estimateTurnTokens([]), 0);
  assert.equal(estimateTurnTokens([msg("user")]), 0);
});

// --- lines changed ----------------------------------------------------------

test("a diff patch is counted, ignoring the +++/--- headers", () => {
  const messages = [msg("user"), msg("assistant", {
    diffs: [{ file: "/a/b.js", patch: "--- a/b.js\n+++ b/b.js\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context" }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 2, removed: 1 });
});

test("an Edit tool is counted from its input when no diff arrives", () => {
  const messages = [msg("user"), msg("assistant", {
    tools: [{ name: "Edit", input: { file_path: "/a/b.js", old_string: "one\ntwo", new_string: "one\ntwo\nthree" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 3, removed: 2 });
});

test("a Write tool counts its whole content as additions", () => {
  const messages = [msg("user"), msg("assistant", {
    tools: [{ name: "Write", input: { file_path: "/a/new.js", content: "a\nb\nc" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 3, removed: 0 });
});

test("a MultiEdit counts every pair in its edits list", () => {
  const messages = [msg("user"), msg("assistant", {
    tools: [{ name: "MultiEdit", input: { file_path: "/a/b.js", edits: [
      { old_string: "a", new_string: "a\nb" },
      { old_string: "c\nd", new_string: "c" }
    ] } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 3, removed: 3 });
});

test("an engine's own edit dialect is recognised", () => {
  const messages = [msg("user"), msg("assistant", {
    tools: [{ name: "replace_file_content", input: { path: "/a/b.py", target_content: "x", replacement_content: "x\ny" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 2, removed: 1 });
});

test("a tool is not counted twice when its diff card already reported it", () => {
  const messages = [msg("user"), msg("assistant", {
    diffs: [{ file: "/a/b.js", patch: "+new\n-old" }],
    tools: [{ name: "Edit", input: { file_path: "/a/b.js", old_string: "old", new_string: "new" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 1, removed: 1 });
});

test("a diff for another file does not suppress the tool that has none", () => {
  const messages = [msg("user"), msg("assistant", {
    diffs: [{ file: "/a/other.js", patch: "+x" }],
    tools: [{ name: "Edit", input: { file_path: "/a/b.js", old_string: "old", new_string: "new\nmore" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 3, removed: 1 });
});

test("read-only tools contribute nothing", () => {
  const messages = [msg("user"), msg("assistant", {
    tools: [{ name: "Read", input: { file_path: "/a/b.js", offset: 5 } }, { name: "Grep", input: { pattern: "x" } }]
  })];
  assert.deepEqual(countTurnChanges(messages), { added: 0, removed: 0 });
});

test("an earlier turn's edits are not counted", () => {
  const messages = [
    msg("assistant", { tools: [{ name: "Write", input: { file_path: "/a/old.js", content: "a\nb\nc" } }] }),
    msg("user"),
    msg("assistant", { tools: [{ name: "Edit", input: { file_path: "/a/new.js", old_string: "a", new_string: "b" } }] })
  ];
  assert.deepEqual(countTurnChanges(messages), { added: 1, removed: 1 });
});

test("an empty turn changes nothing", () => {
  assert.deepEqual(countTurnChanges([]), { added: 0, removed: 0 });
});

test("context usage counts what the cache holds, not just the fresh input", () => {
  assert.equal(contextUsedTokens({ inputTokens: 300, cacheReadInputTokens: 44000, cacheCreationInputTokens: 900 }), 45200);
});

test("engines that report no cache fields are read as-is", () => {
  assert.equal(contextUsedTokens({ inputTokens: 45200 }), 45200);
  assert.equal(contextUsedTokens(), 0);
});

test("token counts use the CLI's shorthand", () => {
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(45200), "45.2k");
  assert.equal(formatTokens(100000), "100k");
  assert.equal(formatTokens(1000000), "1M");
  assert.equal(formatTokens(1234567), "1.2M");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(0), "0");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
