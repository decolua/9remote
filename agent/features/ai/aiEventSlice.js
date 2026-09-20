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

export function aiTailStart(events, maxBytes) {
  const start = fitStart(events, events.length, maxBytes);
  if (start === 0) return 0;
  const snapped = snapWithin(events, start, events.length, maxBytes);
  return backToToolStarts(events, snapped, events.length, maxBytes);
}

// Slice events for window, dropping trailing events exceeding maxBytes.
export function sliceWindow(events, from, end, maxBytes) {
  let last = end;
  while (last > from && aiEventBytes(events[last - 1]) > maxBytes) last--;
  return events.slice(from, last);
}

export function replayWindow(events, maxBytes) {
  const from = aiTailStart(events, maxBytes);
  const window = sliceWindow(events, from, events.length, maxBytes);
  return { events: window, hasMore: from > 0, fromSeq: window[0]?.seq ?? 0 };
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

function backToTurnStart(events, start) {
  let i = start;
  while (i > 0 && events[i].event !== "user_message") i--;
  return events[i]?.event === "user_message" ? i : start;
}
