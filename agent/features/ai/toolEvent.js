// The wire shape of a tool call, in ONE place. Every path that reports a tool — each
// engine's live adapter and each engine's transcript reader — used to spell this out by
// hand, and the copies had already drifted: the replayed result carried no `name`, so a
// task row could only ever be parsed from the live stream, and it carried no `status`
// on the start, so every replayed card claimed "done" from the first paint.
//
// Both keys of a result are always present, empty on the other side, so a card reads one
// shape whichever door the event came through.

/** A tool call has begun; the client opens a card on this id and attaches the result to it. */
export function toolStart({ id, name, input = {}, parentToolUseId = null }) {
  return {
    event: "tool_start",
    data: { id, name, input, status: "running", ...(parentToolUseId ? { parentToolUseId } : {}) }
  };
}

/** What a tool call returned. A non-empty `error` is what makes the card a failure. */
export function toolResult({ id, name, output = "", error = "", parentToolUseId = null }) {
  const failed = Boolean(error);
  return {
    event: "tool_result",
    data: {
      id,
      name,
      output: failed ? "" : output,
      error: failed ? error : "",
      status: failed ? "error" : "done",
      ...(parentToolUseId ? { parentToolUseId } : {})
    }
  };
}
