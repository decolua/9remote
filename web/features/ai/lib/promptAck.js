// Settle-once ack wrapper for ai:prompt (#48): an emit into a dead-but-not-closed
// carrier never errors and never callbacks, so the prompt must time out on its
// own — same discipline as the gate resolver in useAiSession.
export function emitPromptAck(emit, payload, timeoutMs, onLost, schedule = setTimeout, clear = clearTimeout) {
  let settled = false;
  let timer = null;
  const done = (res) => {
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
