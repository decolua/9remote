// A door read that rebuilds the identical log must not re-key it. Bumping the epoch and
// broadcasting a reset on every hydrate invalidated every reader's watermark — each reader
// re-hydrated in turn and the door's 2s coalesce re-armed, a phase-locked cross-device
// refetch loop (the 11-15 storm that ate session clicks on the phone).
// Run: node host/test/aiAdoptLogGuard.test.mjs
import assert from "node:assert/strict";
import { AiSession } from "../features/ai/aiSession.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

const makeSession = () => {
  const emitted = [];
  const s = new AiSession({
    id: `adopt-guard-${Date.now()}`,
    engine: "claude",
    cwd: "/tmp",
    options: { mock: true },
    onEvent: (id, event, data) => emitted.push({ event, data })
  });
  return { s, emitted };
};

// Seed a log the way live events build it; seq/timestamp stay the session's own.
const seed = (s, events) => {
  for (const ev of events) s.history.push({ seq: ++s.seqCounter, ...ev, timestamp: Date.now() });
};

await test("an identical rebuild keeps the log, the epoch, and broadcasts nothing", () => {
  const { s, emitted } = makeSession();
  seed(s, [
    { event: "user_message", data: { text: "hi" } },
    { event: "message", data: { text: "hello" } }
  ]);
  const historyBefore = s.history;
  const epochBefore = s.logEpoch;

  const out = s._adoptLog([
    { event: "user_message", data: { text: "hi" } },
    { event: "message", data: { text: "hello" } }
  ]);

  assert.equal(out, historyBefore, "the existing log object is returned, not a re-keyed copy");
  assert.equal(s.history, historyBefore, "history untouched");
  assert.equal(s.logEpoch, epochBefore, "a plain read must not bump the generation");
  assert.equal(emitted.length, 0, "no reset, no replay — other clients stay where they are");
});

await test("a changed log still resets, bumps the epoch, and replays", () => {
  const { s, emitted } = makeSession();
  seed(s, [{ event: "user_message", data: { text: "hi" } }]);
  const epochBefore = s.logEpoch;

  s._adoptLog([
    { event: "user_message", data: { text: "hi" } },
    { event: "message", data: { text: "new" } }
  ]);

  assert.equal(s.logEpoch, epochBefore + 1, "a genuinely changed log re-keys the generation");
  assert.ok(emitted.some((e) => e.event === "conversation_reset"), "clients must hear about the change");
  assert.ok(s.history.some((ev) => ev.data?.text === "new"), "the new event landed on the log");
});

await test("a content-equal log under different seqs is still a no-op", () => {
  const { s, emitted } = makeSession();
  seed(s, [
    { event: "user_message", data: { text: "a" } },
    { event: "message", data: { text: "b" } }
  ]);
  // A transcript rebuild renumbers from 1; the session's counter may sit higher.
  const epochBefore = s.logEpoch;
  s.seqCounter = 42;

  s._adoptLog([
    { event: "user_message", data: { text: "a" } },
    { event: "message", data: { text: "b" } }
  ]);

  assert.equal(s.logEpoch, epochBefore, "seq layout alone must not invalidate readers");
  assert.equal(emitted.length, 0, "nothing broadcast");
});

await test("key order alone in rebuilt payloads must not invalidate readers", () => {
  const { s, emitted } = makeSession();
  seed(s, [{ event: "message", data: { text: "x", tool: "claude" } }]);

  s._adoptLog([{ event: "message", data: { tool: "claude", text: "x" } }]);

  assert.equal(emitted.length, 0, "same content, different key order — still a no-op");
});

await test("a door read heals missed events quietly — no reset, no broadcast", () => {
  const { s, emitted } = makeSession();
  seed(s, [{ event: "user_message", data: { text: "a" } }]);
  s.cliSessionId = "t-1";
  s._rebuildFromStore = () => ({
    events: [
      { event: "user_message", data: { text: "a" } },
      { event: "message", data: { text: "missed" } }
    ]
  });
  const epochBefore = s.logEpoch;

  s.refreshFromStore();

  assert.equal(s.logEpoch, epochBefore, "no epoch bump — nobody's watermark dies");
  assert.equal(emitted.length, 0, "nothing broadcast; other clients heal via their own aiSince");
  assert.ok(s.history.some((ev) => ev.data?.text === "missed"), "the missed event landed with a fresh seq");
});

await test("a door read never shrinks the log when the transcript lags", () => {
  const { s, emitted } = makeSession();
  seed(s, [
    { event: "user_message", data: { text: "a" } },
    { event: "message", data: { text: "live-tail" } }
  ]);
  s.cliSessionId = "t-1";
  s._rebuildFromStore = () => ({ events: [{ event: "user_message", data: { text: "a" } }] });
  const epochBefore = s.logEpoch;

  s.refreshFromStore();

  assert.equal(s.history.length, 2, "the newer live tail stays");
  assert.equal(s.logEpoch, epochBefore);
  assert.equal(emitted.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
