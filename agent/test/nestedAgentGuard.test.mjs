// A nested AI CLI inherits its parent's NINE_REMOTE_SESSION_ID, so its hooks arrive
// looking exactly like the pane's own. Without a guard the child's Stop clears the
// parent's "working" light and its SessionStart overwrites the pane's transcript path.
//
// The launch token used to come from the daemon's env stamp. Reproducing that needed a
// daemon protocol change, which restarts the daemon and kills every live terminal — so the
// identity is derived here instead, from what the hook payload already carries.
// Run: node agent/test/nestedAgentGuard.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-nested-"));
const sessionMap = await import("../features/terminal/agentSessionMap.js");
sessionMap._setDirForTest(tmp);
const { recordHookEvent, getMapping, isLaunchTokenCurrent, _resetForTest, _fileForTest } = sessionMap;

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const SID = "session-1";
const reset = () => { _resetForTest(); try { fs.unlinkSync(_fileForTest()); } catch {} };

// A hook as it arrives with no env-stamped token — only what Claude itself reports.
const hook = (o) => recordHookEvent({ sessionId: SID, tool: "claude", launchToken: null, ...o });

/* ---- identity comes from the provider session id in the payload ---- */

await test("the first CLI seen on a pane owns it", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w", transcript_path: "/t/parent.jsonl" } });
  assert.equal(getMapping(SID).providerSessionId, "parent");
});

await test("a nested CLI's SessionStart does not steal the pane", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w", transcript_path: "/t/parent.jsonl" } });
  // A subagent or a `claude -p` call started by the parent, inheriting its env.
  hook({ event: "SessionStart", payload: { session_id: "child", cwd: "/w", transcript_path: "/t/child.jsonl" } });

  const m = getMapping(SID);
  assert.equal(m.providerSessionId, "parent");
  assert.equal(m.transcriptPath, "/t/parent.jsonl", "the chat view would switch to the child's conversation");
});

await test("a nested CLI's events do not touch the pane's mapping", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w" } });
  hook({ event: "PostToolUse", payload: { session_id: "child", tool_name: "Bash" } });
  assert.equal(getMapping(SID).providerSessionId, "parent");
});

await test("the parent's own later events still update the mapping", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w" } });
  hook({ event: "PreToolUse", payload: { session_id: "parent", transcript_path: "/t/late.jsonl", tool_name: "Read" } });
  assert.equal(getMapping(SID).transcriptPath, "/t/late.jsonl");
});

/* ---- but a genuinely new run must be able to take over ---- */

await test("a fresh CLI run in the same pane takes ownership once the old one ended", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "first", cwd: "/one" } });
  hook({ event: "SessionEnd", payload: { session_id: "first" } });
  hook({ event: "SessionStart", payload: { session_id: "second", cwd: "/two" } });

  const m = getMapping(SID);
  assert.equal(m.providerSessionId, "second", "quitting claude and starting it again must work");
  assert.equal(m.startCwd, "/two");
});

await test("Stop does not hand the pane over — the CLI is still running", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w" } });
  hook({ event: "Stop", payload: { session_id: "parent" } });
  hook({ event: "SessionStart", payload: { session_id: "child", cwd: "/w" } });
  assert.equal(getMapping(SID).providerSessionId, "parent", "Stop ends a turn, not the session");
});

await test("a pane with no owner accepts the first arrival", () => {
  reset();
  assert.equal(isLaunchTokenCurrent(SID, "anything"), true);
  hook({ event: "PreToolUse", payload: { session_id: "whoever", tool_name: "Read" } });
  assert.equal(getMapping(SID).providerSessionId, "whoever");
});

/* ---- the env-stamped token still wins when a daemon provides one ---- */

await test("an explicit launch token is honoured when present", () => {
  reset();
  recordHookEvent({ sessionId: SID, tool: "claude", event: "SessionStart", launchToken: "tok-a", payload: { session_id: "p1" } });
  assert.equal(isLaunchTokenCurrent(SID, "tok-a"), true);
  assert.equal(isLaunchTokenCurrent(SID, "tok-b"), false);
});

await test("a payload with no session id cannot claim or disturb a pane", () => {
  reset();
  hook({ event: "SessionStart", payload: { session_id: "parent", cwd: "/w" } });
  hook({ event: "PostToolUse", payload: { tool_name: "Bash" } });
  assert.equal(getMapping(SID).providerSessionId, "parent");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
