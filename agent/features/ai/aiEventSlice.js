// Pure helpers for windowing a chat session's event log (an array of { seq, event, data }).
// Extracted from ptyDaemon.js so the slicing is unit-testable without importing the daemon
// (which spawns a PTY on load). Mirrors bufferSlice.js for the terminal's byte buffer.
//
// A window is a frame on the wire: the reply rides the RTC control channel as ONE SCTP
// message, and one byte over the cap is thrown away — the pane then sits on "Syncing…"
// forever, since every re-ask rebuilds the same oversize frame. So the budget here is
// measured the way the wire measures it, and a window that returns never exceeds it.

// What one event costs on the wire: the codec JSON-serializes it into the frame header
// verbatim, so this is exact, not an estimate. Counting character data alone (the old
// `text.length`) missed the repeated keys, the escapes and the metadata around it — a
// factor of ~2.4 — and the tail it picked overshot the 64KB SCTP message cap.
export function aiEventBytes(ev) {
  return JSON.stringify(ev)?.length ?? 0;
}

// Serialized size of a whole window — what the slice will actually cost on the wire.
export function windowBytes(events) {
  let bytes = 0;
  for (const ev of events) bytes += aiEventBytes(ev) + 1;
  return bytes + 2;
}

// Index where the newest events fitting `maxBytes` begin, stopping BEFORE the budget is
// passed: the earlier walk added first and checked after, so it returned one event over
// — and a single streamed `thinking` event measured 28KB.
//
// An event too large for ANY window can never be sent, so trailing ones are stepped over
// — otherwise the newest event being oversize would empty the window while older events
// still fit. Only trailing: skipping one in the middle and carrying on would build a
// window with a hole in it, which the client reads as contiguous history.
function fitStart(events, end, maxBytes) {
  let i = end;
  while (i > 0 && aiEventBytes(events[i - 1]) > maxBytes) i--;
  let bytes = 0;
  while (i > 0) {
    const n = aiEventBytes(events[i - 1]);
    if (bytes + n > maxBytes) break;
    bytes += n;
    i--;
  }
  return i;
}

// Start on the prompt that opens the turn containing `start` — but only while that still
// fits the budget. An agentic turn runs hundreds of events with no prompt of its own, and
// walking back to one there reaches the top of the log: the "tail" becomes the whole
// conversation and the reply is refused by the wire. A turn heading is worth less than a
// window over budget, so the window then starts at the next prompt FORWARD instead —
// never mid-turn where a prompt exists, and always a subset of a window already known to
// fit, so this cannot push one over.
function snapWithin(events, start, end, maxBytes) {
  const snapped = backToTurnStart(events, start);
  if (snapped !== start && windowBytes(events.slice(snapped, end)) <= maxBytes) return snapped;
  let i = start;
  while (i < end && events[i].event !== "user_message") i++;
  return i < end ? i : start;
}

// Index where the newest `maxBytes` of `events` begin. A log under the budget returns 0.
export function aiTailStart(events, maxBytes) {
  const start = fitStart(events, events.length, maxBytes);
  return start === 0 ? 0 : snapWithin(events, start, events.length, maxBytes);
}

// The events a window holds, minus any single event too large to be sent at all. A
// payload nested deeper than the log's own cap walks still gets here whole, and a frame
// is only ever this budget wide — one missing card costs less than a reply the wire
// throws away. Trailing ones only: dropping one from the middle would leave a hole the
// client reads as contiguous history.
export function sliceWindow(events, from, end, maxBytes) {
  let last = end;
  while (last > from && aiEventBytes(events[last - 1]) > maxBytes) last--;
  return events.slice(from, last);
}

// The one door for a replay: the events to send, whether more sits behind them, and the
// seq the window starts at. It returns the events rather than an index on purpose — an
// index is not a window (an oversize event at the tail survives one), and every caller
// handed an index had to remember a second step. Two of them had already forgotten.
export function replayWindow(events, maxBytes) {
  const from = aiTailStart(events, maxBytes);
  const window = sliceWindow(events, from, events.length, maxBytes);
  return { events: window, hasMore: from > 0, fromSeq: window[0]?.seq ?? 0 };
}

// Scroll-up fetch: the chunk of events older than `before` (a seq), newest chunk first.
// `before` is the oldest seq the client holds; nothing at or above it is returned.
export function aiHistoryChunk(events, before, maxBytes) {
  if (!before) return { events: [], hasMore: false };
  const idx = events.findIndex((e) => e.seq >= before);
  const end = idx === -1 ? events.length : idx;
  const fit = fitStart(events, end, maxBytes);
  // Paging from `fit`, never from past the stepped-over event: `fitStart` already walked
  // over the trailing ones, so the client's next `before` lands beyond them and the
  // scroll-up keeps moving instead of asking for the same impossible event forever.
  const from = snapWithin(events, fit, end, maxBytes);
  return { events: sliceWindow(events, from, end, maxBytes), hasMore: from > 0 };
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
