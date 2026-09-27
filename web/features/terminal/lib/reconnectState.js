// Reset transient terminal state that can get stuck across a bus disconnect.
// R2: historyFetchingRef/historyHaveAtEmitRef — if disconnect lands mid requestHistory,
//     the ack never fires and the ref stays true → scroll-up history fetch dead.
// R3: awaitingTuiOutputRef — if disconnect lands mid SGR wheel round-trip, handleOutput
//     never fires → touch scroll TUI stalls until backpressure timeout.
// R5: joiningRef/joinQueueRef — if disconnect lands mid joinSession, the ack never fires so
//     joiningRef stays true → all live output stays queued forever (blank terminal). Clear both;
//     doJoinSession on reconnect re-arms cleanly. joinClaimedRef rides along: it is claimed
//     before the join is even emitted, so a carrier dying in that window would strand it
//     set and every later recovery would stand down for a join that is long gone.
// R4 is handled in doFitAndJoin (sets lastPtySizeRef after emitting resize) so that
// doResize dedups correctly after the rejoin — not here.
// R6: awaitingGapRef — if disconnect lands mid requestGap, the ack never fires so
//     live output stays queued forever. Clear the ref + its fallback timer; rejoin
//     re-arms cleanly.
//
// `refs` is an object of { current } ref-like holders (React useRef shape).
export function resetReconnectState(refs) {
  if (!refs) return;
  if (refs.historyFetching) refs.historyFetching.current = false;
  if (refs.historyHaveAtEmit) refs.historyHaveAtEmit.current = 0;
  if (refs.awaitingTuiOutput) refs.awaitingTuiOutput.current = false;
  if (refs.joining) refs.joining.current = false;
  if (refs.joinClaimed) refs.joinClaimed.current = false;
  if (refs.joinQueue) refs.joinQueue.current = [];
  // R7: a fragmented history prefix cut short by the disconnect would never complete
  // (part count never reached) and hold its bytes forever — drop it; the in-flight
  // fetch the fragments belong to is being reset above anyway.
  if (refs.prefixFrags) refs.prefixFrags.current = null;
  if (refs.awaitingGap) {
    if (refs.awaitingGap.current?.timer) clearTimeout(refs.awaitingGap.current.timer);
    refs.awaitingGap.current = null;
  }
}

// Who owns the recovery lane right now. Exactly one occupant at a time: a peek
// asking the host for its newest seq, a gapFetch pulling a missing range, or a
// join on its way to wiping the pane. The rule was spelled out inline at each of
// runRecover's two decision points, and the join was missing from both — so a
// second trigger during one ran straight through and wiped the scrollback the
// first had just painted. One expression, one place to add the next occupant.
export function recoveryBusy({ joinClaimed, joining, gapBusy }) {
  return Boolean(joinClaimed?.current || joining?.current || gapBusy);
}
