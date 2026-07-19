// Reset transient terminal state that can get stuck across a socket disconnect.
// R2: historyFetchingRef/historyHaveAtEmitRef — if disconnect lands mid requestHistory,
//     the ack never fires and the ref stays true → scroll-up history fetch dead.
// R3: awaitingTuiOutputRef — if disconnect lands mid SGR wheel round-trip, handleOutput
//     never fires → touch scroll TUI stalls until backpressure timeout.
// R5: joiningRef/joinQueueRef — if disconnect lands mid joinSession, the ack never fires so
//     joiningRef stays true → all live output stays queued forever (blank terminal). Clear both;
//     doJoinSession on reconnect re-arms cleanly.
// R4 is handled in doFitAndJoin (sets lastPtySizeRef after emitting resize) so that
// doResize dedups correctly after the rejoin — not here.
//
// `refs` is an object of { current } ref-like holders (React useRef shape).
export function resetReconnectState(refs) {
  if (!refs) return;
  if (refs.historyFetching) refs.historyFetching.current = false;
  if (refs.historyHaveAtEmit) refs.historyHaveAtEmit.current = 0;
  if (refs.awaitingTuiOutput) refs.awaitingTuiOutput.current = false;
  if (refs.joining) refs.joining.current = false;
  if (refs.joinQueue) refs.joinQueue.current = [];
}
