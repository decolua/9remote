// The recovery lane across a join's settle debounce, driven through the REAL
// createJoinSession — not a restatement of it. A mock of the join would have kept
// passing after the refs key it reads drifted, which is exactly the mistake this
// guards: the flag is claimed by the hook and lowered inside termJoin, so the two
// must agree on its name.
//
// doJoinSession does not join — it asks doResize to join once the layout settles,
// because PTY cols is one-way and a snapshot at a transient width wraps scrollback
// narrow forever. The seq baseline only arrives with the replay AFTER that join
// acks, so from the decision to rejoin until the replay lands, lastSeq is null.
// Every trigger in that window used to see a free lane and a null baseline, and
// start the whole blind rejoin over — the spinner flashing twice.
// Run: node --import ./test/loader-alias.mjs web/test/joinLaneClaim.test.mjs
import assert from "node:assert/strict";
import { recoveryBusy } from "../features/terminal/lib/reconnectState.js";
import { createJoinSession } from "../features/terminal/lib/termJoin.js";

let pass = 0, fail = 0;
// Awaits fn: a sync helper marks an async test passed the moment it returns a
// promise, so every assertion after the first await is never checked.
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);

const mk = (v) => ({ current: v });

// A join wired the way useXTerm wires it, with the socket answering on demand.
function harness() {
  const refs = {
    historyMirrorRef: mk([]), historyBytesRef: mk(0), historyTotalRef: mk(0),
    historyFetchingRef: mk(false), userAtTopRef: mk(false),
    joiningRef: mk(false), joinClaimedRef: mk(false), joinQueueRef: mk([]),
    joinGenRef: mk(0), lastSeqRef: mk(null), cwdRef: mk("/"),
    setJoining: () => {}
  };
  let ack = null;
  const fireJoinRef = mk(null);
  const doJoinSession = createJoinSession({
    bus: { emit: (_e, _p, cb) => { ack = cb; } },
    sessionId: "s1",
    term: { write: () => {}, reset: () => {} },
    fitAddon: {},
    writeBatcherRef: mk({ write: () => {}, flush: () => {} }),
    doResizeRef: mk(() => {}),
    fireJoinRef,
    refs,
    setCwd: () => {}
  });
  return {
    refs,
    lane: () => recoveryBusy({
      joinClaimed: refs.joinClaimedRef, joining: refs.joiningRef, gapBusy: false
    }),
    // What hardRejoin does: claim, then hand off — doJoinSession only ARMS the
    // join; doResize fires it once the layout settles.
    claim() { refs.joinClaimedRef.current = true; doJoinSession(true); },
    settle() { fireJoinRef.current(80, 24); },
    ack(result = { success: true, seq: 42 }) { ack?.(result); },
    flush() { return new Promise((r) => setTimeout(r, 0)); }
  };
}

await test("held from the rejoin decision through the settle debounce", () => {
  const h = harness();
  h.claim();
  // 21:14:58.971 in the log — the join does not emit until 59.090.
  assert.equal(h.lane(), true, "a trigger during the debounce must stand down");
});

await test("still held between the join emit and its ack", () => {
  const h = harness();
  h.claim();
  h.settle();
  // 59.090 → 02.094: three seconds where lastSeq is still null.
  assert.equal(h.lane(), true, "this is the window the second wipe came through");
});

await test("termJoin releases the lane on ack — under the key the hook actually passes", async () => {
  const h = harness();
  h.claim();
  h.settle();
  h.ack();
  await h.flush(); // the ack defers its bookkeeping one tick
  assert.equal(h.refs.joinClaimedRef.current, false, "a key mismatch here strands recovery forever");
  assert.equal(h.lane(), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
