// The live-event door: one prompt, drawn once.
//
// A hydrate replays the host's log, and the turn that prompted it is often in that log
// already — the client sent its prompt while the round was in flight. The events that
// arrive during the round are held, then drained after the replay. Without the host's seq
// there was no way to tell the drained copies from news, so the prompt bubble and the
// answer both landed twice.
// Run: node web/test/aiSeqDedupe.test.mjs
import assert from "node:assert/strict";
import { isAlreadyApplied } from "../features/ai/lib/seqDedupe.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// The hook's gate, in the order it now runs: the watermark is checked BEFORE a delta is
// buffered, and `flushStreamed()` has already put the frame's held text in the store.
const live = (payload, appliedSeq) => (isAlreadyApplied(payload.seq, appliedSeq) ? null : payload);

test("an event the replayed snapshot already covers is dropped", () => {
  // The hydrate replayed up to seq 40; the held `user_message` is seq 39.
  assert.equal(live({ event: "user_message", seq: 39 }, 40), null);
  assert.equal(live({ event: "delta", seq: 38 }, 40), null, "the answer's text, not just the bubble");
});

test("an event past the watermark is applied", () => {
  const ev = { event: "delta", seq: 41 };
  assert.equal(live(ev, 40), ev);
});

test("a delta is gated exactly like any other event", () => {
  // The bug this pins: the stream branch returned before the gate, so a replayed delta
  // appended its text a second time while the prompt bubble was already covered — the
  // answer grew a duplicate tail on every hydrate that landed mid-turn.
  assert.equal(live({ event: "delta", seq: 40 }, 40), null, "at the watermark is still covered");
  assert.equal(live({ event: "thinking", seq: 40 }, 40), null);
});

test("nothing is a duplicate before the first hydrate numbers it", () => {
  // A fresh pane, or an ack that carried no log: the watermark is 0, so the turn's own
  // events are its only copy and must all land.
  assert.equal(live({ event: "user_message", seq: 1 }, 0)?.event, "user_message");
  assert.equal(live({ event: "delta", seq: 7 }, 0)?.event, "delta");
});

test("an unstamped event passes — an older host has no seq to compare", () => {
  // Dropping these would lose real turns to be safe about replayed ones.
  assert.equal(live({ event: "user_message" }, 40)?.event, "user_message");
  assert.equal(live({ event: "delta" }, 40)?.event, "delta");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
