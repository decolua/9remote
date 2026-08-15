// Unit tests for agentSessionMap — provider session mapping persisted next to sessions.json.
// Run: node agent/test/agentSessionMap.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-agentmap-"));

const {
  recordHookEvent, getMapping, getAllMappings, clearMapping,
  isLaunchTokenCurrent, _resetForTest, _fileForTest, _setDirForTest,
} = await import("../features/terminal/agentSessionMap.js");

_setDirForTest(tmp);

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const reset = () => {
  _resetForTest();
  try { fs.unlinkSync(_fileForTest()); } catch {}
};

await test("SessionStart records provider id, transcript and start cwd", () => {
  reset();
  recordHookEvent({
    sessionId: "s1", tool: "claude", event: "SessionStart",
    payload: { session_id: "prov-1", transcript_path: "/t/a.jsonl", cwd: "/work/proj" },
  });
  const m = getMapping("s1");
  assert.equal(m.tool, "claude");
  assert.equal(m.providerSessionId, "prov-1");
  assert.equal(m.transcriptPath, "/t/a.jsonl");
  assert.equal(m.startCwd, "/work/proj");
});

await test("startCwd is pinned at first sight — later cwd drift does not overwrite it", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p", cwd: "/start" } });
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "PreToolUse", payload: { session_id: "p", cwd: "/elsewhere" } });
  assert.equal(getMapping("s1").startCwd, "/start", "claude --resume resolves the project dir from cwd — must keep the original");
});

await test("transcript_path is taken verbatim, never rebuilt from the id", () => {
  reset();
  // Newer Claude names the JSONL with a UUID that differs from the hook session_id.
  recordHookEvent({
    sessionId: "s1", tool: "claude", event: "SessionStart",
    payload: { session_id: "aaa-111", transcript_path: "/p/bbb-222.jsonl", cwd: "/w" },
  });
  assert.equal(getMapping("s1").transcriptPath, "/p/bbb-222.jsonl");
});

await test("a later event fills fields that were missing, without clobbering known ones", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p1", cwd: "/w" } });
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "PostToolUse", payload: { session_id: "p1", transcript_path: "/t/x.jsonl", cwd: "/w2" } });
  const m = getMapping("s1");
  assert.equal(m.transcriptPath, "/t/x.jsonl");
  assert.equal(m.providerSessionId, "p1");
  assert.equal(m.startCwd, "/w");
});

await test("a second CLI appearing while the first still runs does NOT take the pane", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p1", cwd: "/one" } });
  // A nested `claude` or a subagent inherits the pane's env, so its hooks look identical
  // apart from the provider session id. Letting it through hands the pane to the child.
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p2", cwd: "/two" } });
  const m = getMapping("s1");
  assert.equal(m.providerSessionId, "p1");
  assert.equal(m.startCwd, "/one");
});

await test("after the first CLI ends, a new run takes the pane and re-pins cwd", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p1", cwd: "/one" } });
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionEnd", payload: { session_id: "p1" } });
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p2", cwd: "/two" } });
  const m = getMapping("s1");
  assert.equal(m.providerSessionId, "p2", "quitting claude and starting it again must work");
  assert.equal(m.startCwd, "/two");
});

await test("missing sessionId is ignored — never creates an unattributable entry", () => {
  reset();
  recordHookEvent({ sessionId: "", tool: "claude", event: "SessionStart", payload: { session_id: "p" } });
  recordHookEvent({ sessionId: null, tool: "claude", event: "SessionStart", payload: { session_id: "p" } });
  assert.deepEqual(getAllMappings(), {});
});

await test("mapping survives a reload from disk", () => {
  reset();
  recordHookEvent({
    sessionId: "s1", tool: "claude", event: "SessionStart",
    payload: { session_id: "p1", transcript_path: "/t/a.jsonl", cwd: "/w" },
  });
  _resetForTest(); // drop in-memory state, force a disk read
  const m = getMapping("s1");
  assert.equal(m.providerSessionId, "p1");
  assert.equal(m.startCwd, "/w");
});

await test("clearMapping removes only the target session", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p1" } });
  recordHookEvent({ sessionId: "s2", tool: "codex", event: "SessionStart", payload: { session_id: "p2" } });
  clearMapping("s1");
  assert.equal(getMapping("s1"), null);
  assert.equal(getMapping("s2").providerSessionId, "p2");
});

/* ---- launch token: nested agents inherit the pane env and must not hijack it ---- */

await test("first token seen for a pane becomes the current one", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", launchToken: "tok-a", payload: { session_id: "p1" } });
  assert.equal(isLaunchTokenCurrent("s1", "tok-a"), true);
});

await test("a different token on the same pane is a nested agent — rejected", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", launchToken: "tok-a", payload: { session_id: "p1" } });
  assert.equal(isLaunchTokenCurrent("s1", "tok-nested"), false);
});

await test("a nested agent's event does not overwrite the parent mapping", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", launchToken: "tok-a", payload: { session_id: "parent", cwd: "/w" } });
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", launchToken: "tok-b", payload: { session_id: "child", cwd: "/w" } });
  assert.equal(getMapping("s1").providerSessionId, "parent");
});

await test("no token supplied — legacy hooks still work (backward compatible)", () => {
  reset();
  recordHookEvent({ sessionId: "s1", tool: "claude", event: "SessionStart", payload: { session_id: "p1" } });
  assert.equal(isLaunchTokenCurrent("s1", undefined), true);
  assert.equal(isLaunchTokenCurrent("s1", ""), true);
});

await test("a pane with no mapping accepts any token (first writer wins)", () => {
  reset();
  assert.equal(isLaunchTokenCurrent("unknown", "whatever"), true);
});

await test("corrupt state file degrades to empty instead of throwing", () => {
  reset();
  fs.writeFileSync(_fileForTest(), "{ not json", "utf8");
  _resetForTest();
  assert.deepEqual(getAllMappings(), {});
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
