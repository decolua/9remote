// How many messages of a long chat the list keeps mounted. A turn carrying a diff and a
// tool's output can run to hundreds of KB, so the DOM holds a byte budget instead of the
// whole log; the rest is revealed on scroll-up.
//
// The window's top is a mark that only ever moves UP (toward older messages), never down.
// Recomputing it from a byte budget measured at the newest message would slide it down on
// every append, hiding turns the user had already been shown — which is what made a
// "load older" affordance appear mid-conversation with no reload involved.

// One page. Must match AI_REPLAY_BYTES (agent/features/ai/constants.js): the host answers
// a hydrate with that much tail, so a smaller budget here would hide part of what was
// just sent — every reopened chat would open with a "load older" button above it.
export const PAGE_BUDGET_BYTES = 128 * 1024;

// Ceiling on the mounted DOM. The top mark alone cannot bound it: once the top is pinned,
// the bottom follows every new turn, so a long-lived pane would mount the whole session.
// Past this the top has to move — which is exactly when paging is legitimate.
export const MAX_MOUNTED_BYTES = 512 * 1024;

export function estimateMessageBytes(msg) {
  if (!msg) return 0;
  let bytes = (msg.content?.length || 0) + (msg.thinking?.length || 0);
  if (Array.isArray(msg.tools)) {
    for (const t of msg.tools) {
      bytes += (t.command?.length || 0) + (t.output?.length || 0) + 120;
    }
  }
  if (Array.isArray(msg.diffs)) {
    for (const d of msg.diffs) {
      bytes += (d.diff?.length || 0) + (d.file?.length || 0) + 80;
    }
  }
  return Math.max(bytes, 100);
}

// Counts back from `fromIndex` until the budget is spent (at least `minCount` messages,
// so a slice is never empty). Returns the index the window starts at.
export function countMessagesByBudget(messages, budgetBytes, fromIndex, minCount = 2) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const end = Math.min(fromIndex ?? messages.length, messages.length);
  let accumulated = 0;
  let count = 0;
  for (let i = end - 1; i >= 0; i--) {
    accumulated += estimateMessageBytes(messages[i]);
    count++;
    if (accumulated >= budgetBytes && count >= minCount) break;
  }
  return end - count;
}

// The mounted window's top: the id of the message it starts on, and that id's index.
//   - a mark still present in the log is HELD — appends land below it, so the window never
//     shrinks from the top while the agent works (the bug: recomputing the top from the
//     newest message each render slid it down until turns appeared to fall off);
//   - a mark the log no longer holds (a hydrate renumbers ids, a reset replaces the log)
//     opens a fresh page from the tail. It must NOT fall back to the head — that would
//     mount the whole session, the very freeze paging exists to prevent.
// The ceiling bounds the DOM and outranks a held mark, or an unattended pane mounts the
// whole session. But it is the UNATTENDED bound only: the caller raises `pageBytes` on
// every "load older", and that request has to outrank it. Clamped to the ceiling instead,
// the top was pulled back down the moment a long chat crossed it — the button kept
// fetching, the view stopped moving, and the rest of the log was unreachable.
export function windowTop(prevTopId, messages, pageBytes, ceilingBytes) {
  if (!messages?.length) return { id: null, index: 0 };
  const fresh = countMessagesByBudget(messages, pageBytes, undefined);
  const held = prevTopId != null ? messages.findIndex((m) => m.id === prevTopId) : -1;
  const bound = countMessagesByBudget(messages, Math.max(ceilingBytes, pageBytes), undefined);
  const index = held < 0 ? fresh : Math.max(held, bound);
  return { id: messages[index].id, index };
}

// Does the mounted window open mid-turn? The host answers a hydrate with a tail measured
// in bytes, and one agentic turn can run past that budget — so a reopened chat mounts a
// column of tool cards with no prompt bubble above them. That is the normal opening for
// an agentic chat (measured: 23 of 46 real ones, one turn running 194 steps), so the
// pane fetches until it opens on a bubble; lib/aiReach proves scroll-up reaches the top
// of the worst of them either way.
export function opensMidTurn(messages, hiddenCount, hasOlder) {
  if (!hasOlder || !messages?.length) return false;
  // The first message the window mounts is what the reader sees at the top. A prompt
  // opens a turn; anything else means the turn's own bubble sits above the window — even
  // when nothing is hidden, which is the log whose prompts the event cap shed.
  return messages[hiddenCount]?.role !== "user";
}
