// The span of the last turn, measured by the host. The pane prints "Worked for …" from
// it, and a client that loads AFTER the turn ended saw neither edge of it — its own clock
// has nothing to measure, which is why the number has to survive on the host, and why it
// is a duration rather than two timestamps (the two clocks sit on different machines).
// Run: node agent/test/aiTurnSpan.test.mjs
import assert from "node:assert/strict";
import { AiSession } from "../features/ai/aiSession.js";
import { publicSession } from "../features/ai/aiSocket.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running AI turn span tests...");

const makeSession = () => new AiSession({ id: "span", engine: "claude", cwd: "/tmp", options: { mock: true } });

await test("a turn stamps its span on the way out, and the host publishes it", () => {
  const s = makeSession();
  s.emitNormalized("user_message", { text: "hi" });
  assert.equal(s.lastTurnMs, 0, "a running turn has no span yet");
  // Backdate the mark rather than asserting an exact difference: the clock is real, so a
  // millisecond can pass between the two reads and an equality assert goes flaky.
  s.turnStartedAt = Date.now() - 4200;
  s.emitNormalized("turn_complete", { stats: {} });
  const span = s.lastTurnMs;
  assert.ok(span >= 4200 && span < 4400, `expected ~4200ms, got ${span}`);
  assert.equal(publicSession(s).lastTurnMs, span);
});

await test("a spawn-time event is not a turn — nothing to measure", () => {
  const s = makeSession();
  s.emitNormalized("init", { model: "claude-sonnet-5" });
  s.emitNormalized("exit", {});
  assert.equal(s.lastTurnMs, 0, "an exit before any prompt must not read as a finished turn");
});

await test("/clear drops the span along with the conversation it belonged to", () => {
  const s = makeSession();
  s.emitNormalized("user_message", { text: "hi" });
  s.emitNormalized("turn_complete", { stats: {} });
  s.lastTurnMs = 900;
  s.sendPrompt("/clear");
  assert.equal(s.lastTurnMs, 0);
  assert.equal(publicSession(s).lastTurnMs, null, "null, not 0 — the pane reads 0 as falsy anyway");
});

await test("a reset states the log's own turn state — the client clears it a frame later", () => {
  // The host broadcasts conversation_reset alongside every hydrate, and the client applies
  // it AFTER the ack that carried the same state. A reset that stayed silent would wipe
  // the summary the ack had just restored, which is the whole point of the change.
  const s = makeSession();
  const seen = [];
  s.onEvent = (id, event, data) => { if (event === "conversation_reset") seen.push(data); };
  s.lastTurnMs = 1500;
  s.cliSessionId = "fake-id";
  s._rebuildFromStore = () => [
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "turn_complete", data: {} }
  ];
  assert.equal(s.refreshFromStore(), true);
  assert.equal(seen.at(-1).lastTurnMs, 1500);
  // The rebuild does not re-emit the turn, so the span must survive it untouched.
  assert.equal(s.lastTurnMs, 1500);
});

await test("a F5 mid-turn resets to RUNNING, with the duration to count from", () => {
  // The bug this pins: restoring only the span left the pane printing "Worked for …" over
  // an answer that was still streaming, because the reset had just said the turn was over.
  //
  // The state carries a DURATION, never the host's timestamp: the two machines sit on
  // different clocks, so a client subtracting one from the other would print the skew.
  const s = makeSession();
  s.onEvent = () => {};
  s.cliSessionId = "fake-id";
  s._rebuildFromStore = () => [{ seq: 1, event: "user_message", data: { text: "hi" } }];
  s.isTurnRunning = true;
  s.turnStartedAt = Date.now() - 5000;
  const reset = [];
  s.onEvent = (id, event, data) => { if (event === "conversation_reset") reset.push(data); };
  s.refreshFromStore();
  assert.equal(reset.at(-1).isTurnRunning, true);
  assert.ok(reset.at(-1).elapsedMs >= 5000, `expected ~5000ms, got ${reset.at(-1).elapsedMs}`);
  assert.equal(reset.at(-1).lastTurnMs, 0, "a running turn has no span to print");
  assert.equal(reset.at(-1).turnStartedAt, undefined, "a host mark would be read on the wrong clock");
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`\nAll tests passed: ${pass}/${pass}`);
