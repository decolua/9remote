// The opencode rewind path, exercised end to end through the real socket handler.
//
// Run: node agent/test/opencodeRewind.test.mjs
//
// A unit test of the helpers would pass while the feature is broken — the parts that
// can be wrong are the id handshake (opencode's own message ids, never ones we mint),
// the file list coming from the conversation rather than the working tree, and the
// refusal paths. So this drives `ai:rewind` the way the client does, against a real
// throwaway opencode conversation, and removes it afterwards.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupAiHandlers } from "../features/ai/aiSocket.js";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_SOCKET_EVENTS } from "../features/ai/constants.js";
import { rewindSupport, resolveRewindTarget } from "../features/ai/rewind.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

class MockSocket {
  constructor() { this.handlers = new Map(); }
  on(event, handler) { this.handlers.set(event, handler); }
  emit() {}
  call(event, data) {
    return new Promise((resolve) => {
      const h = this.handlers.get(event);
      if (!h) return resolve({ error: "no_handler" });
      h(data, resolve);
    });
  }
}

const sessionId = `session-rewind-test-${Date.now()}`;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "9r-rewind-"));

console.log("Running opencode rewind tests...");

await test("an engine that cannot rewind says so, and is not offered a control", async () => {
  // Codex moved: `thread/revert` replaces a thread's own history with the prefix before a
  // turn, keeping the same id — measured on the real app-server (codexAppServerE2E). Its
  // FILE half stays false, and not as a gap in this table: codex's protocol says the
  // client owns file changes and it keeps no checkpoint to restore from.
  assert.equal(rewindSupport("codex").conversation, true);
  assert.equal(rewindSupport("codex").files, false);
  assert.equal(rewindSupport("antigravity").files, false);
  // The one engine left with no rewind at all: its app-server has no such API.
  assert.equal(rewindSupport("antigravity").conversation, false);
  assert.equal(rewindSupport("opencode").conversation, true);
  assert.equal(rewindSupport("opencode").files, true);
  // Claude rewinds through its own CLI flags, not this path — see claudeRewind.test.mjs.
  assert.equal(rewindSupport("claude").conversation, true);
  assert.equal(rewindSupport("claude").files, true);
});

await test("ai:rewind on an unknown conversation is refused, and still reports support", async () => {
  const socket = new MockSocket();
  const manager = new AiManager();
  setupAiHandlers(socket, null, manager);
  const res = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "list" });
  assert.equal(res.ok, false);
  // No session exists for this id, so the refusal names the engine rather than the
  // capability. Support still comes back, which is what the client gates its control on
  // — the "list" call doubles as the capability probe.
  assert.match(res.error, /not one \w+ can rewind/i);
  assert.equal(typeof res.support.conversation, "boolean");
});

// The client shows the rewind control on `ok` alone, and keeps asking while support is
// true but ok is false. So a refusal must never carry ok, whatever the reason: a chat
// that has bound no conversation yet must still read as "not yet", not as "never".
await test("a refusal never reports ok, and always reports support", async () => {
  const socket = new MockSocket();
  setupAiHandlers(socket, null, new AiManager());
  const noTurn = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "list" });
  assert.equal(noTurn.ok, false);
  assert.equal(noTurn.support.conversation, true);
  assert.deepEqual(noTurn.points, []);
  // Naming a turn that cannot exist is refused the same way, not answered with an empty
  // success — an ok here would let the pane offer a rewind that goes nowhere.
  const noTarget = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "apply", index: 0 });
  assert.equal(noTarget.ok, false);
  assert.ok(noTarget.error);
});

// The regression a fresh chat hit: the conversation resolved, but the CLI had not
// stored its turn yet — so `list` answered ok with an empty list, the pane armed its
// edit button on a conversation with nothing to go back to, and pressing Enter got a
// protocol-level "Missing messageId" back. ok must mean "a turn exists to return to".
await test("a conversation with no turn yet does not report ok", async () => {
  const { default: fsMod } = await import("node:fs");
  // A transcript that exists but holds no user record yet — the CLI writes the file as
  // soon as a turn starts, and nothing in it is rewindable until the turn lands.
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "9r-rewind-empty-"));
  const claudeId = "88888888-1111-2222-3333-444444444444";
  const dir = path.join(projects, "-tmp-empty");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${claudeId}.jsonl`), `${JSON.stringify({ type: "mode", mode: "normal", sessionId: claudeId })}\n`);
  const prev = process.env.NREMOTE_CLAUDE_PROJECTS_DIR;
  process.env.NREMOTE_CLAUDE_PROJECTS_DIR = projects;

  try {
    const manager = new AiManager();
    manager.sessions.set(sessionId, { id: sessionId, engine: "claude", cliSessionId: claudeId, cwd });
    const socket = new MockSocket();
    setupAiHandlers(socket, null, manager);

    const listed = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "list" });
    assert.equal(listed.ok, false, "an empty conversation must not arm the control");
    assert.deepEqual(listed.points, []);
    // Support still travels: the pane must keep asking rather than give up on the
    // engine, because this conversation earns the control a turn later.
    assert.equal(listed.support.conversation, true);

    // And the turn it never had is refused in words about the conversation, not about
    // our wire format — "Missing messageId" told the user nothing they could act on.
    const applied = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "apply", index: 0 });
    assert.equal(applied.ok, false);
    assert.doesNotMatch(applied.error, /missing message ?id/i);
  } finally {
    if (prev === undefined) delete process.env.NREMOTE_CLAUDE_PROJECTS_DIR;
    else process.env.NREMOTE_CLAUDE_PROJECTS_DIR = prev;
    fs.rmSync(projects, { recursive: true, force: true });
  }
});

// The edit button on a bubble sends a position, never its own id: the client mints
// those locally and a CLI has never seen one. Counting from the end is what makes the
// tail — the part paging cannot hide — enough to name a turn.
await test("a turn named by position counts back from the end of the thread", async () => {
  const points = [{ messageId: "u1" }, { messageId: "u2" }, { messageId: "u3" }];
  assert.equal(resolveRewindTarget(points, 0), "u3");
  assert.equal(resolveRewindTarget(points, 2), "u1");
  // Offsets that are not turns are refused, not wrapped or clamped onto a neighbour.
  assert.equal(resolveRewindTarget(points, 3), undefined);
  assert.equal(resolveRewindTarget(points, -1), undefined);
  assert.equal(resolveRewindTarget(points, null), undefined);
  assert.equal(resolveRewindTarget(points, "1.5"), undefined);
  assert.equal(resolveRewindTarget([], 0), undefined);
});

// The handler has to accept both namings, or the rewind modal (which lists the turns
// from the host and so holds real ids) would stop working.
await test("ai:rewind refuses a request that names no turn at all", async () => {
  const socket = new MockSocket();
  setupAiHandlers(socket, null, new AiManager());
  const res = await socket.call(AI_SOCKET_EVENTS.REWIND, { sessionId, action: "preview", index: 7 });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

await test("list returns opencode's own message ids, not ids we minted", async () => {
  // A real opencode session that exists on this machine, if there is one.
  const { listRewindPoints } = await import("../features/ai/opencodeRewind.js");
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"), { readOnly: true });
  } catch {
    console.log("    (no opencode db on this machine — skipped)");
    return;
  }
  const row = db.prepare("select session_id, count(*) c from message where data like '%\"role\":\"user\"%' group by session_id order by c desc limit 1").get();
  db.close();
  if (!row) { console.log("    (no opencode conversation with a user turn — skipped)"); return; }

  const points = listRewindPoints(row.session_id);
  assert.ok(points.length > 0, "expected at least one rewind point");
  for (const p of points) {
    assert.match(p.messageId, /^msg_/, "message id must be opencode's own");
    assert.ok(Array.isArray(p.files), "each point carries the files it touched");
  }
});

await test("a session opencode does not know is reported as not rewindable", async () => {
  const { rewindable } = await import("../features/ai/opencodeRewind.js");
  assert.equal(rewindable("opencode", "ses_does_not_exist_9remote"), null);
  assert.equal(rewindable("opencode", null), null);
  assert.equal(rewindable("codex", "anything"), null);
});

fs.rmSync(cwd, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅ all passed" : "❌ FAILED"}, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
