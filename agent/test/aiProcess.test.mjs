// Tests for AI Process Managers & Normalization
// Run: node agent/test/aiProcess.test.mjs
import assert from "node:assert/strict";
import { AiManager } from "../features/ai/aiManager.js";
import { AI_ENGINES } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI Process Manager tests...");

await test("AI_ENGINES contains claude, codex, and opencode", () => {
  assert.equal(AI_ENGINES.CLAUDE, "claude");
  assert.equal(AI_ENGINES.CODEX, "codex");
  assert.equal(AI_ENGINES.OPENCODE, "opencode");
});

await test("AiManager creates and retrieves session", () => {
  const manager = new AiManager();
  const session = manager.createSession("test-session-1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  assert.equal(session.id, "test-session-1");
  assert.equal(session.engine, "claude");
  assert.equal(session.cwd, "/tmp");
  assert.equal(manager.getSession("test-session-1"), session);
});

await test("AiManager rejects invalid engine", () => {
  const manager = new AiManager();
  assert.throws(() => {
    manager.createSession("invalid-sess", "unknown-engine", "/tmp", { mock: true });
  }, /Invalid AI engine/);
});

await test("AiManager lists active sessions", () => {
  const manager = new AiManager();
  manager.createSession("s1", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  manager.createSession("s2", AI_ENGINES.CODEX, "/tmp", { mock: true });
  const list = manager.listSessions();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(s => s.id).sort(), ["s1", "s2"]);
});

await test("AiManager destroys session cleanly", () => {
  const manager = new AiManager();
  manager.createSession("s1", AI_ENGINES.OPENCODE, "/tmp", { mock: true });
  assert.ok(manager.getSession("s1"));
  manager.destroySession("s1");
  assert.equal(manager.getSession("s1"), undefined);
});

await test("AiManager broadcast event listener receives engine events", (t) => {
  const manager = new AiManager();
  const received = [];
  manager.onEvent((sessionId, event, data) => {
    received.push({ sessionId, event, data });
  });

  const session = manager.createSession("s-event", AI_ENGINES.CLAUDE, "/tmp", { mock: true });
  session.emitNormalized("delta", { text: "Hello" });

  assert.equal(received.length, 1);
  assert.equal(received[0].sessionId, "s-event");
  assert.equal(received[0].event, "delta");
  assert.equal(received[0].data.text, "Hello");
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
} else {
  console.log(`\nAll tests passed: ${pass}/${pass}`);
}
