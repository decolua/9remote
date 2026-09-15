// What a reload leaves on the pane: the turn line at the tail of the history.
//
// It has no home in the host's event log — a transcript rebuild emits no `turn_complete`
// of its own — so the host states the span and the turn state on the hydrate ack, and the
// client has to land on those values whichever order ack and reset arrive in. Three bugs
// lived here, all of them showing up as the summary silently reverting on the next F5.
// Run: node web/test/aiTurnState.test.mjs
import assert from "node:assert/strict";
import { useAiStore } from "../shared/stores/aiStore.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// The reset the host broadcasts with every hydrate, applied right after the ack, then the
// replayed events, then the host's own restatement of the turn (see useAiSession).
const afterReset = (reset, replay = [], restate = null) => {
  useAiStore.getState().clearMessages("s1");
  useAiStore.getState().restoreTurnState("s1", reset);
  for (const ev of replay) {
    if (ev.event === "turn_complete") useAiStore.getState().finishTurn("s1", ev.data.stats, ev.data.turnMs);
    if (ev.event === "user_message") useAiStore.getState().addUserMessage("s1", ev.data.text);
  }
  if (restate) useAiStore.getState().restoreTurnState("s1", restate);
};

test("the host's restatement outranks a replay that ends on turn_complete", () => {
  // The bug behind "no stop control": a rebuild from the transcript ends on a
  // turn_complete, so the replay alone made a live turn look finished on every reload.
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  afterReset({}, [{ event: "turn_complete", data: { stats: {} } }], { isTurnRunning: true, elapsedMs: 27746 });
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, true);
  assert.equal(sess.lastTurnMs, 0);
  assert.ok(Date.now() - sess.turnStartedAt >= 27746, "the live line counts the whole turn");
});

test("the host's restatement also ends a turn the replay reopened", () => {
  // The mirror bug: a log replayed mid-turn carries the prompt but no ending, so the pane
  // spun on a turn the host had already finished.
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  afterReset({}, [{ event: "user_message", data: { text: "hi" } }], {
    isTurnRunning: false, lastTurnMs: 4200
  });
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, false);
  assert.equal(sess.lastTurnMs, 4200);
  assert.equal(sess.turnStartedAt, 0, "a finished turn has no mark for the live line");
});

test("a finished turn keeps the host's span through the reset that follows the ack", () => {
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  afterReset({ isTurnRunning: false, lastTurnMs: 90000, turnStartedAt: 1_700_000_000_000 });
  assert.equal(useAiStore.getState().bySession.s1.lastTurnMs, 90000);
});

test("the replayed turn_complete does not overwrite it with a ~0ms span", () => {
  // The bug: restoring turnStartedAt for a FINISHED turn left the replayed turn_complete
  // measuring from that fresh mark, so every reload reported the turn as instantaneous.
  // The host states a non-zero mark — it only clears it on /clear — so this is the shape
  // the reset really arrives in.
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  afterReset({ isTurnRunning: false, lastTurnMs: 90000, turnStartedAt: 1_700_000_000_000 }, [
    { event: "turn_complete", data: { stats: { outputTokens: 5 } } }
  ]);
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.turnStartedAt, 0, "a finished turn carries no start mark to measure from");
  assert.equal(sess.lastTurnMs, 90000);
});

test("a live turn stays live, with a mark its own clock can count from", () => {
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  const before = Date.now();
  afterReset({ isTurnRunning: true, lastTurnMs: 0, turnStartedAt: 1_700_000_000_000 });
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, true, "the stop control lives off this flag");
  assert.equal(sess.lastTurnMs, 0, "a running turn has no span to print");
  assert.ok(sess.turnStartedAt >= before, "the host's mark is another clock — must not be used directly");
});

test("a reset from a host that states nothing leaves the cleared values alone", () => {
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  afterReset({});
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, false);
  assert.equal(sess.lastTurnMs, 0);
});

test("a reset carrying only a span never paints over a streaming turn", () => {
  // Seen in the wild: the turn was streaming and the pane said "Worked for …". A reset
  // that does not state the turn says nothing about it, so the ack's live state stands.
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  useAiStore.getState().hydrateSession("s1", { isTurnRunning: true, elapsedMs: 120000 });
  useAiStore.getState().clearMessages("s1");
  useAiStore.getState().restoreTurnState("s1", { hasMore: true, fromSeq: 4, lastTurnMs: 90000 });
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, true);
  assert.equal(sess.lastTurnMs, 0);
});

test("a turn joined mid-flight counts the host's elapsed, not from the page load", () => {
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  const before = Date.now();
  useAiStore.getState().hydrateSession("s1", { isTurnRunning: true, elapsedMs: 300000 });
  const { turnStartedAt } = useAiStore.getState().bySession.s1;
  // Five minutes in when this pane loaded, so the mark sits five minutes in the past.
  assert.ok(Math.abs(before - 300000 - turnStartedAt) < 1000, `mark was ${before - turnStartedAt}ms ago`);
});

test("replayed events cannot move the turn — the 'Worked for 0s' case", () => {
  // Straight from a real log: a hydrate of session-…076607 landed lastTurnMs=1 while the
  // chat had been running for minutes. The replayed pair below is why — the prompt reset
  // the mark and the turn_complete right behind it measured from that fresh mark.
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  useAiStore.getState().hydrateSession("s1", { isTurnRunning: true, elapsedMs: 71000 });
  const anchored = useAiStore.getState().bySession.s1.turnStartedAt;
  useAiStore.getState().clearMessages("s1");
  useAiStore.getState().restoreTurnState("s1", { isTurnRunning: true, elapsedMs: 71000 });
  // The replayed history, tagged as such.
  useAiStore.getState().addUserMessage("s1", "earlier prompt", null, true);
  useAiStore.getState().finishTurn("s1", { outputTokens: 5 }, 0, true);
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, true, "a replayed ending must not end the live turn");
  assert.equal(sess.lastTurnMs, 0, "no span may be invented from a replayed pair");
  // The anchor is re-derived from the host's duration at each door, so the two calls land
  // a millisecond apart on a real clock. What matters is that the replay did not move it
  // by the ~71s the host reported — an exact equality here is a flaky assert, not a check.
  assert.ok(Math.abs(sess.turnStartedAt - anchored) < 1000, `anchor moved by ${sess.turnStartedAt - anchored}ms`);
});

test("a live turn_complete still ends the turn it belongs to", () => {
  useAiStore.setState({ bySession: {} });
  useAiStore.getState().initSession("s1");
  useAiStore.getState().addUserMessage("s1", "do it");
  useAiStore.getState().finishTurn("s1", { outputTokens: 5 }, 4200);
  const sess = useAiStore.getState().bySession.s1;
  assert.equal(sess.isTurnRunning, false);
  assert.equal(sess.lastTurnMs, 4200);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
