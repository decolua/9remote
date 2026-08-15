// Tests for how /api/notify reads a hook call: query params, JSON body, and the rule
// that a mapping-only event must never disturb the pane's status.
// Run: node agent/test/notifyParams.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9r-notify-"));

const sessionMap = await import("../features/terminal/agentSessionMap.js");
const promptStore = await import("../features/agentChat/promptStore.js");
const statusManager = await import("../features/terminal/statusManager.js");
const { handleNotifyPost, handleNotifyGet, handleNotifyDebugGet } = await import("../api/notify.js");
const { clearHookTrace } = await import("../features/agentChat/hookTrace.js");

sessionMap._setDirForTest(tmp);

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const SID = "session-1";

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.writeHead = (c, h) => { res.statusCode = c; Object.assign(res.headers, h); return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b; return res; };
  return res;
}

function post(query, bodyObj) {
  const req = new EventEmitter();
  const res = fakeRes();
  const done = handleNotifyPost(req, res, { query });
  const body = bodyObj == null ? "" : (typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj));
  if (body) req.emit("data", body);
  req.emit("end");
  return done.then(() => res);
}

const reset = () => {
  promptStore._resetAllForTest();
  sessionMap._resetForTest();
  try { fs.unlinkSync(sessionMap._fileForTest()); } catch {}
  statusManager.setStatus(SID, null);
};

/* ---- always acks: a hook that errors would stall the AI CLI ---- */

await test("a valid hook call is acked", async () => {
  reset();
  const res = await post({ type: "blocked", sessionId: SID, tool: "claude", event: "PermissionRequest" },
    { hook_event_name: "PermissionRequest", tool_name: "Bash", session_id: "p1" });
  assert.equal(res.statusCode, 200);
});

await test("an unparseable body is still acked, and does not throw", async () => {
  reset();
  const res = await post({ type: "working", sessionId: SID, tool: "claude" }, "{ not json");
  assert.equal(res.statusCode, 200);
});

await test("a body with no session id is acked and ignored", async () => {
  reset();
  const res = await post({ type: "working", tool: "claude" }, { hook_event_name: "PreToolUse" });
  assert.equal(res.statusCode, 200);
});

await test("a GET with query params only is acked", () => {
  reset();
  const res = fakeRes();
  handleNotifyGet({}, res, { query: { type: "done", sessionId: SID, tool: "claude" } });
  assert.equal(res.statusCode, 200);
});

/* ---- payload reaches the mapping + prompt store ---- */

await test("a POST body populates the session mapping", async () => {
  reset();
  await post({ type: "idle", sessionId: SID, tool: "claude", event: "SessionStart" },
    { hook_event_name: "SessionStart", session_id: "prov-1", transcript_path: "/t/a.jsonl", cwd: "/work" });
  const m = sessionMap.getMapping(SID);
  assert.equal(m.providerSessionId, "prov-1");
  assert.equal(m.transcriptPath, "/t/a.jsonl");
  assert.equal(m.startCwd, "/work");
});

await test("a permission payload becomes a pending prompt", async () => {
  reset();
  await post({ type: "blocked", sessionId: SID, tool: "claude", event: "PermissionRequest" },
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  const p = promptStore.getPrompt(SID);
  assert.equal(p.toolName, "Bash");
  assert.equal(p.toolInput.command, "ls");
});

await test("the body's hook_event_name wins over the query's event", async () => {
  reset();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "Stop" },
    { hook_event_name: "PermissionRequest", tool_name: "Bash" });
  assert.ok(promptStore.getPrompt(SID), "the body is authoritative — the query is only a fallback");
});

await test("telemetry is recorded even with no browser attached", async () => {
  reset();
  // getIO() is null in this harness — exactly the state while the user has no tab open.
  // The CLI keeps running regardless, so its hooks must still land or the chat view
  // would be empty for everything that happened before the first connect.
  await post({ type: "working", sessionId: SID, tool: "claude", event: "PreToolUse" },
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.js" } });
  assert.equal(promptStore.getActivity(SID).length, 1);
});

/* ---- SessionStart must not disturb the status light ---- */

await test("SessionStart does not clear a working status", async () => {
  reset();
  statusManager.applyEvent({ type: "working", sessionId: SID, tool: "claude" });
  await post({ type: "idle", sessionId: SID, tool: "claude", event: "SessionStart" },
    { hook_event_name: "SessionStart", session_id: "p1", cwd: "/w" });
  assert.equal(statusManager.getStatus(SID).state, "working", "a mapping-only hook must not reset the pane");
});

await test("a real status event still moves the state machine", async () => {
  reset();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "UserPromptSubmit" },
    { hook_event_name: "UserPromptSubmit", prompt: "hi" });
  assert.equal(statusManager.getStatus(SID).state, "working");
});

/* ---- nested agents ---- */

await test("a foreign launch token is dropped entirely", async () => {
  reset();
  await post({ type: "idle", sessionId: SID, tool: "claude", event: "SessionStart", launchToken: "tok-parent" },
    { hook_event_name: "SessionStart", session_id: "parent", cwd: "/w" });
  await post({ type: "blocked", sessionId: SID, tool: "claude", event: "PermissionRequest", launchToken: "tok-parent" },
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "parent" } });

  // A subprocess inherits the session id but carries its own token.
  await post({ type: "done", sessionId: SID, tool: "claude", event: "Stop", launchToken: "tok-child" },
    { hook_event_name: "Stop" });

  assert.equal(promptStore.getPrompt(SID).toolInput.command, "parent");
});

/* ---- the debug trace: what you reach for when the chat view is missing something ---- */

function debugTrace(query = {}) {
  const res = fakeRes();
  handleNotifyDebugGet({}, res, { query });
  return JSON.parse(res.body);
}

await test("the trace records an arriving hook with its raw body", async () => {
  reset(); clearHookTrace();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "UserPromptSubmit" },
    { hook_event_name: "UserPromptSubmit", prompt: "fix the bug" });
  const [latest] = debugTrace().trace;
  assert.equal(latest.parsed.event, "UserPromptSubmit");
  assert.equal(latest.outcome, "ingested");
  assert.ok(latest.rawBody.includes("fix the bug"), "the raw body is the point — it survives parsing");
});

await test("a hook that forwarded nothing is visibly distinct from one that did", async () => {
  reset(); clearHookTrace();
  // This is THE failure mode: the hook fires, returns 200, and carries no payload.
  await post({ type: "working", sessionId: SID, tool: "claude", event: "UserPromptSubmit" }, "");
  const [latest] = debugTrace().trace;
  assert.equal(latest.outcome, "noPayload");
  assert.equal(latest.rawBodyLength, 0);
});

await test("a dropped hook records WHY it was dropped", async () => {
  reset(); clearHookTrace();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "SessionStart", launchToken: "tok-a" },
    { hook_event_name: "SessionStart", session_id: "p1" });
  await post({ type: "done", sessionId: SID, tool: "claude", event: "Stop", launchToken: "tok-other" },
    { hook_event_name: "Stop" });
  const dropped = debugTrace().trace.find((e) => e.outcome === "dropped");
  assert.ok(dropped, "a silently dropped hook is the hardest kind to diagnose");
  assert.match(dropped.detail, /launchToken/);
});

await test("a hook with no session id is traced rather than vanishing", async () => {
  reset(); clearHookTrace();
  await post({ type: "working", tool: "claude" }, { hook_event_name: "PreToolUse" });
  const [latest] = debugTrace().trace;
  assert.equal(latest.outcome, "dropped");
  assert.match(latest.detail, /sessionId/);
});

await test("the trace is newest-first and bounded", async () => {
  reset(); clearHookTrace();
  for (let i = 0; i < 60; i++) {
    await post({ type: "working", sessionId: SID, tool: "claude", event: "PreToolUse" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `/f${i}` } });
  }
  const { trace } = debugTrace();
  assert.ok(trace.length <= 50, "an unbounded trace would leak for the life of the process");
  assert.ok(trace[0].n > trace[1].n, "newest first — that is what you are looking for");
});

await test("a huge payload is clipped in the trace", async () => {
  reset(); clearHookTrace();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "PostToolUse" },
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_response: "z".repeat(200_000) });
  const [latest] = debugTrace().trace;
  assert.ok(latest.rawBody.length < 5_000);
  assert.ok(latest.rawBodyLength > 100_000, "but the true size is still reported");
});

await test("clear=1 empties the trace", async () => {
  reset(); clearHookTrace();
  await post({ type: "working", sessionId: SID, tool: "claude", event: "PreToolUse" },
    { hook_event_name: "PreToolUse", tool_name: "Read" });
  assert.ok(debugTrace().trace.length > 0);
  debugTrace({ clear: "1" });
  assert.equal(debugTrace().trace.length, 0);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
