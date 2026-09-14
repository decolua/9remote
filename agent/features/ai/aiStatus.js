// Which status a chat session's own events imply, and the one thing they may not do.
//
// The chat UI is a front-end for the same CLI a terminal runs, so both feed ONE state
// machine (terminal/statusManager). This is the chat side's vocabulary; the terminal
// side's is TYPE_TO_STATE over the hook's `type=`. Neither knows about the other — they
// only share the door they knock on.
export const EVENT_TO_STATE = Object.freeze({
  user_message: "working",
  tool_start: "working",
  permission_resolved: "working",
  permission_request: "blocked",
  blocked: "blocked",
  turn_complete: "done",
  // The CLI was interrupted or failed, so the dot is not claiming an answer is waiting
  // to be read. `done` is reserved for a turn that actually finished.
  stopped: "idle",
  stall: "idle",
  error: "idle",
  exit: "idle",
});

// The events that restate "the turn is moving" — true of a turn sitting on an approval
// prompt too, so they are never the thing that clears one.
const RESTATED_BY_HOOK = new Set(["user_message", "tool_start"]);

/**
 * Would this event clear a gate the CLI is still holding?
 *
 * Two `blocked`s look identical in the status map and come from opposite places:
 *   - a CARD is open (claude's control_request). The CLI is waiting on US, and a typed
 *     message does not answer it — the client denies the card as it sends, so
 *     `permission_resolved` follows within the same gesture and moves the dot itself.
 *     Filtering here only avoids a blocked→working flicker, and if that resolution never
 *     comes (a client that does not deny on send) staying blocked is the honest answer.
 *   - no card (codex's sandbox refusal, opencode's auto-reject): the CLI reporting a fact
 *     about itself, which the next turn does not change. Nothing is filtered — the turn
 *     really is running, and the dot must say so.
 * `gateHeld` is the only thing that tells the two apart.
 */
export const restatesOverGate = (event, currentState, gateHeld) =>
  currentState === "blocked" && Boolean(gateHeld) && RESTATED_BY_HOOK.has(event);

// The events that release the turn's own flag. The same table read the other way: a turn
// is over once its event says the CLI finished or stopped being busy. Derived, not a
// second list — two hand-kept lists are how `error`/`exit` were once missed here and a
// pane came back from an F5 spinning on a process that was already gone.
export const TURN_END_EVENTS = new Set(
  Object.keys(EVENT_TO_STATE).filter((e) => EVENT_TO_STATE[e] === "done" || EVENT_TO_STATE[e] === "idle")
);
