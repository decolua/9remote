// Pure helpers for windowing a chat session's event log (an array of { seq, event, data }).
// Extracted from ptyDaemon.js so the slicing is unit-testable without importing the daemon
// (which spawns a PTY on load). Mirrors bufferSlice.js for the terminal's byte buffer.

// Rough serialized size of one event — only ever used to pick a window boundary, so a
// tool result's output dominates and everything else can share one small estimate.
export function aiEventBytes(ev) {
  return ev?.data?.text?.length || ev?.data?.output?.length || 256;
}

// Index where the newest `maxBytes` of `events` begin. A log under the budget returns 0.
// Backs up to the user_message that opens the turn, so a replayed tail never starts on a
// half turn (an orphan reply bubble with no prompt above it).
export function aiTailStart(events, maxBytes) {
  let bytes = 0;
  let i = events.length;
  while (i > 0 && bytes < maxBytes) bytes += aiEventBytes(events[--i]);
  return backToTurnStart(events, i > 0 && bytes >= maxBytes ? i : 0);
}

// Scroll-up fetch: the chunk of events older than `before` (a seq), newest chunk first.
// `before` is the oldest seq the client holds; nothing at or above it is returned.
export function aiHistoryChunk(events, before, maxBytes) {
  if (!before) return { events: [], hasMore: false };
  const idx = events.findIndex((e) => e.seq >= before);
  const end = idx === -1 ? events.length : idx;
  let bytes = 0;
  let start = end;
  while (start > 0 && bytes < maxBytes) bytes += aiEventBytes(events[--start]);
  return { events: events.slice(backToTurnStart(events, start), end), hasMore: start > 0 };
}

// Walk back to the user_message that OPENS the turn containing `start`, so a chunk or a
// replayed tail never begins mid-turn. The nearest one at or before `start`, never an
// earlier turn's: overshooting to a previous user_message would drag a whole extra turn
// in and leave the boundary before it unreachable.
function backToTurnStart(events, start) {
  let i = start;
  while (i > 0 && events[i].event !== "user_message") i--;
  return events[i]?.event === "user_message" ? i : start;
}
