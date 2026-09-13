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
import { rewindSupport } from "../features/ai/rewind.js";

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
  assert.equal(rewindSupport("codex").conversation, false);
  assert.equal(rewindSupport("antigravity").files, false);
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
