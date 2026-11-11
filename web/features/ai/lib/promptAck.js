// Settle-once ack wrapper for ai:prompt (#48): an emit into a dead-but-not-closed
// carrier never errors and never callbacks, so the prompt must time out on its
// own — same discipline as the gate resolver in useAiSession.
// onOk fires EXACTLY ONCE on the first ok ack, early or late (the sequenced stream
// may deliver after the timeout) — the caller chains the follow-up send or
// withdraws the error it already showed.
export function emitPromptAck(emit, payload, timeoutMs, onLost, schedule = setTimeout, clear = clearTimeout, onOk = null) {
  let settled = false;
  let okSeen = false;
  let timer = null;
  const done = (res) => {
    if (res?.ok && !okSeen) { okSeen = true; onOk?.(); }
    if (settled) return;
    settled = true;
    clear(timer);
    // ok|queued both mean the host received it — the user_message echo draws the bubble.
    if (res?.ok) return;
    onLost(res?.error || "timeout");
  };
  emit(payload, done);
  timer = schedule(() => done(null), timeoutMs);
}
