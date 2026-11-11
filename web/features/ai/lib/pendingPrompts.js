// Prompts sent but not yet confirmed by the host, kept per session in localStorage so
// a reload between "sent" and "acked" offers the text back instead of losing it.
// Attachments are not kept (base64 would blow the quota); only the words survive.

const KEY_PREFIX = "9remote_pendingPrompts_";

function keyOf(sessionId) {
  return `${KEY_PREFIX}${sessionId}`;
}

export function readPending(sessionId, storage = globalThis.localStorage) {
  if (!sessionId || !storage) return [];
  try {
    const list = JSON.parse(storage.getItem(keyOf(sessionId)) || "[]");
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.text === "string") : [];
  } catch {
    return [];
  }
}

function write(sessionId, list, storage) {
  if (!sessionId || !storage) return;
  try {
    if (list.length) storage.setItem(keyOf(sessionId), JSON.stringify(list));
    else storage.removeItem(keyOf(sessionId));
  } catch {
    // Quota or private mode: the in-memory error bar still covers this page's life.
  }
}

// `page` names this page life, so a reconnect never mistakes its own in-flight prompt for an orphan.
export function addPending(sessionId, entry, storage = globalThis.localStorage) {
  if (!entry?.id || !entry.text) return;
  const list = readPending(sessionId, storage).filter((p) => p.id !== entry.id);
  list.push({ id: entry.id, text: entry.text, page: entry.page || "", at: Number.isFinite(entry.at) ? entry.at : Date.now() });
  write(sessionId, list, storage);
}

export function clearPending(sessionId, storage = globalThis.localStorage) {
  write(sessionId, [], storage);
}

export function removePending(sessionId, id, storage = globalThis.localStorage) {
  const list = readPending(sessionId, storage);
  const next = list.filter((p) => p.id !== id);
  if (next.length !== list.length) write(sessionId, next, storage);
}

// The host echoed this text: whichever pending entry holds it was delivered.
export function removePendingByText(sessionId, text, storage = globalThis.localStorage) {
  const list = readPending(sessionId, storage);
  const at = list.findIndex((p) => p.text === text);
  if (at === -1) return;
  list.splice(at, 1);
  write(sessionId, list, storage);
}

// The user dismissed or took back a lost prompt: forget every entry it holds.
export function removePendingWithin(sessionId, text, storage = globalThis.localStorage) {
  if (!text) return;
  const list = readPending(sessionId, storage);
  const next = list.filter((p) => !text.includes(p.text));
  if (next.length !== list.length) write(sessionId, next, storage);
}

// Prompts another page life left unconfirmed, minus any the replayed log shows as delivered.
// Entries younger than minAgeMs may still be in flight in another tab — left alone.
export function takeOrphans(sessionId, { deliveredTexts = [], page = "", minAgeMs = 0, now = Date.now() } = {}, storage = globalThis.localStorage) {
  const list = readPending(sessionId, storage);
  if (!list.length) return [];
  const delivered = new Set(deliveredTexts);
  const orphans = [];
  const keep = [];
  for (const p of list) {
    if (p.page === page || now - (p.at || 0) < minAgeMs) { keep.push(p); continue; }
    if (!delivered.has(p.text)) orphans.push(p);
  }
  write(sessionId, keep, storage);
  return orphans;
}
