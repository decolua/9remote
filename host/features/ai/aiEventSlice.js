// Windowing helpers for chat session event log bounded by SCTP message size limits.

import { AI_REPLAY_WIDEN_BYTES } from "./constants.js";

// Exact wire byte cost of JSON-serialized event.
export function aiEventBytes(ev) {
  return JSON.stringify(ev)?.length ?? 0;
}

export function windowBytes(events) {
  let bytes = 0;
  for (const ev of events) bytes += aiEventBytes(ev) + 1;
  return bytes + 2;
}

// Find start index of newest events fitting maxBytes, skipping trailing oversized events.
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

// Snap to prompt opening the turn containing start if within budget, else next forward prompt.
function snapWithin(events, start, end, maxBytes) {
  const snapped = backToTurnStart(events, start);
  if (snapped !== start && windowBytes(events.slice(snapped, end)) <= maxBytes) return snapped;
  let i = start;
  while (i < end && events[i].event !== "user_message") i++;
  return i < end ? i : start;
}

// Walk start back to include tool_start events for any tool_result within window.
function backToToolStarts(events, start, end, maxBytes) {
  if (start === 0) return start;
  const owner = new Map();
  for (let i = 0; i < end; i++) {
    const ev = events[i];
    if (ev.event === "tool_start" && ev.data?.id) owner.set(ev.data.id, i);
  }
  let first = start;
  for (let i = start; i < end; i++) {
    const ev = events[i];
    if (ev.event !== "tool_result" || !ev.data?.id) continue;
    const at = owner.get(ev.data.id);
    if (at != null && at < first) first = at;
  }
  if (first === start) return start;
  return windowBytes(events.slice(first, end)) <= Math.max(maxBytes, AI_REPLAY_WIDEN_BYTES) ? first : start;
}

// A sub-agent card is drawn nested under its parent's card; the client drops it when
// that parent is not in the same window. So a window must never open on one.
const isChildEvent = (ev) =>
  ev.event === "tool_child" || ev.event === "tool_result_child";

// A window that holds only closings draws nothing: no prompt, no prose, no card.
// A `turn_complete` or a lone `cli_event` is the tail of a turn, not a chat.
const isContentEvent = (ev) =>
  ev.event === "user_message" || ev.event === "delta" || ev.event === "thinking" ||
  ev.event === "tool_start" || ev.event === "tool_result" || ev.event === "diff";

/**
 * Where the newest drawable window starts.
 *
 * A turn can be wider than the byte budget — a heavy sub-agent alone runs to
 * megabytes — so reaching a child's spawner is not always possible. What must never
 * happen is shipping only children: the client drops every one of them and the chat
 * opens blank (measured: a real 946-event log rendered zero messages).
 *
 * So: take the normal tail, and if it holds nothing drawable, step back to the most
 * recent prompt. That range is then narrowed by `drawable` + the byte cap, which is
 * what makes it fit: the megabytes a sub-agent costs are exactly the events the pane
 * cannot use.
 */
function coherentStart(events, start, end) {
  // The same rule `drawable` applies to the finished window: a sub-agent card needs
  // its spawner, a tool result needs its call.
  const calls = new Set();
  for (let i = start; i < end; i++) {
    const ev = events[i];
    if (ev.event === "tool_start" && ev.data?.id) calls.add(ev.data.id);
  }
  const drawableEvent = (ev) => {
    if (isChildEvent(ev)) return calls.has(ev.data?.parentToolUseId);
    if (ev.event === "tool_result" && ev.data?.id) return calls.has(ev.data.id);
    return isContentEvent(ev);
  };
  for (let i = start; i < end; i++) {
    if (drawableEvent(events[i])) return start;
  }
  // Nothing drawable in the tail: open on the prompt that started this stretch.
  for (let i = start - 1; i >= 0; i--) {
    if (events[i].event === "user_message") return i;
  }
  return start;
}

export function aiTailStart(events, maxBytes) {
  const start = fitStart(events, events.length, maxBytes);
  if (start === 0) return coherentStart(events, 0, events.length);
  const snapped = snapWithin(events, start, events.length, maxBytes);
  const withParents = backToToolStarts(events, snapped, events.length, maxBytes);
  return coherentStart(events, withParents, events.length);
}

// The window's events, minus sub-agent cards whose spawner is not in it.
function drawable(events) {
  const calls = new Set();
  for (const ev of events) if (ev.event === "tool_start" && ev.data?.id) calls.add(ev.data.id);
  return events.filter((ev) => {
    if (isChildEvent(ev)) return calls.has(ev.data?.parentToolUseId);
    if (ev.event === "tool_result" && ev.data?.id) return calls.has(ev.data.id);
    return true;
  });
}

// Slice events for window, dropping trailing events exceeding maxBytes.
export function sliceWindow(events, from, end, maxBytes) {
  let last = end;
  while (last > from && aiEventBytes(events[last - 1]) > maxBytes) last--;
  return events.slice(from, last);
}

export function replayWindow(events, maxBytes) {
  // Bookkeeping records — hooks, task ticks, attachments — draw no bubble of their own.
  // Left in the budget they spent the frame on rows the pane never paints and pushed the
  // answer itself out (measured: a turn closing with ~25KB of hook attachments). They stay
  // in the log for paging and the live path; only the opening window skips them.
  const usable = events.some((ev) => ev.event === "cli_event")
    ? events.filter((ev) => ev.event !== "cli_event")
    : events;
  const from = aiTailStart(usable, maxBytes);
  const inTurn = usable.slice(from);
  // Orphans are judged against what is actually sent: the spawner may exist megabytes
  // earlier and still be outside this budget.
  const tail = drawable(newestFit(inTurn, maxBytes));
  const window = tail.some(isContentEvent) ? tail : standaloneWindow(inTurn, maxBytes);
  const hasMore = from > 0 || window.length < usable.length;
  return { events: window, hasMore, fromSeq: window[0]?.seq ?? 0 };
}

// A turn wider than the budget spends its tail on sub-agent cards whose spawner is out
// of reach; stripping them leaves nothing to draw. Fall back to the newest events that
// stand on their own, led by the prompt they answer — the pane opens on the end of the
// conversation with something to read above it, instead of on a blank.
function standaloneWindow(inTurn, maxBytes) {
  const own = inTurn.filter((ev) => !isChildEvent(ev));
  const tail = drawable(newestFit(own, maxBytes));
  const prompt = inTurn.find((ev) => ev.event === "user_message");
  if (!prompt || tail.includes(prompt)) return tail;
  const led = [prompt, ...tail];
  return windowBytes(led) <= maxBytes ? led : tail;
}

// The newest events within the budget, stepping over one too wide for any window.
function newestFit(events, maxBytes) {
  return sliceWindow(events, fitStart(events, events.length, maxBytes), events.length, maxBytes);
}

// Fetch chunk of events older than before seq.
export function aiHistoryChunk(events, before, maxBytes) {
  if (!before) return { events: [], hasMore: false };
  const idx = events.findIndex((e) => e.seq >= before);
  const end = idx === -1 ? events.length : idx;
  const fit = fitStart(events, end, maxBytes);
  const from = snapWithin(events, fit, end, maxBytes);
  const starts = backToToolStarts(events, from, end, maxBytes);
  return { events: sliceWindow(events, starts, end, maxBytes), hasMore: starts > 0 };
}

// Events strictly after a watermark, oldest-first, byte-capped. `hasMore` true means
// the gap reaches past the cap — the client is too far behind to patch and must resync.
export function eventsSince(events, after, maxBytes) {
  const idx = events.findIndex((e) => (e.seq ?? 0) > after);
  if (idx === -1) return { events: [], hasMore: false };
  let end = idx;
  let bytes = 0;
  while (end < events.length) {
    const n = aiEventBytes(events[end]) + 1;
    if (bytes + n > maxBytes) break;
    bytes += n;
    end++;
  }
  return { events: events.slice(idx, end), hasMore: end < events.length };
}

function backToTurnStart(events, start) {
  let i = start;
  while (i > 0 && events[i].event !== "user_message") i--;
  return events[i]?.event === "user_message" ? i : start;
}
