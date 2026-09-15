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

// A launch ack for work that outlives its own tool call: the CLI returns the moment the
// work is handed off, naming the handle it will report on later. Claude's async
// sub-agents ("Async agent launched successfully…", keyed by agentId) and its background
// shells ("Command running in background with ID: …") are both this shape — so BOTH stay
// `running` on the wire even though the call itself has returned, and the client's agent
// strip and shell chip show work that is genuinely still in flight.
//
// The handle is kept on the event, so a row can be settled early by a later call naming
// it. Nothing does that yet — both kinds settle on their own timeout (see AiSession).

// Each engine spells the ack its own way; `name` is whatever the handle is called here.
//
// No `\b` before the key: the result reaches this as JSON, so a real newline arrives as
// the two characters `\` and `n` — and `n` is a word character, which kills the boundary
// the anchor needed. The escaped form is the ONLY form seen in practice.
const ACK_PATTERNS = [
  /Async agent launched successfully[^]*?agentId:\s*([A-Za-z0-9_-]+)/i,
  /Command running in background with ID:\s*([A-Za-z0-9_-]+)/i,
];

// Only these can hand work off and return early. The gate is the tool NAME, not the
// output alone: a result that merely CONTAINS an ack — a Read of a file that quotes one —
// otherwise marks that row as live work forever (verified against a real log: two `Read`
// results matched the shell pattern exactly that way).
const LAUNCHER_TOOLS = new Set(["Agent", "Task", "Bash"]);

/** The handle an async launch ack names, or null when this result is an ordinary one. */
export function asyncHandle(output = "", name = "") {
  if (!LAUNCHER_TOOLS.has(name)) return null;
  const text = typeof output === "string" ? output : "";
  if (!text) return null;
  for (const re of ACK_PATTERNS) {
    const m = re.exec(text);
    if (m) return { id: m[1], handle: true };
  }
  return null;
}
