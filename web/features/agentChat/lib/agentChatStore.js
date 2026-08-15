// One subscription per session, shared by every component watching it.
//
// The pane needs the state to decide whether to show the toggle; the chat view needs it to
// render. Without sharing, both subscribe and every activity event costs two round-trips.
// Follows the same ref-counted shape as useGitChangedCount.
import { EVENTS } from "../constants/agentChatConfig.js";

// Claude fires a hook per tool call; a turn can produce dozens in a second. Coalesce the
// refetches so a busy turn is a handful of requests, not one per event.
export const REFETCH_DEBOUNCE_MS = 120;

const EMPTY = Object.freeze({
  hasAgent: false, tool: null, prompt: null, activity: [], optionCount: 0, stale: false,
});

// sessionId → entry
const entries = new Map();

let handleSeq = 0;

function notify(entry) {
  for (const sub of entry.subs.values()) {
    try { sub(entry.state); } catch { /* a bad subscriber must not stop the others */ }
  }
}

function fetchNow(entry, socket, sessionId) {
  socket.emit(EVENTS.SUBSCRIBE, { sessionId }, (res) => {
    if (!res?.success || !entries.has(sessionId)) return;
    entry.state = {
      hasAgent: !!res.hasAgent,
      tool: res.tool || null,
      prompt: res.prompt || null,
      activity: res.activity || [],
      optionCount: res.optionCount || 0,
      stale: false,
      live: entry.state.live || null,
    };
    notify(entry);
  });
}

function scheduleFetch(entry, socket, sessionId) {
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    fetchNow(entry, socket, sessionId);
  }, REFETCH_DEBOUNCE_MS);
}

function createEntry(socket, sessionId) {
  const entry = { state: EMPTY, subs: new Map(), timer: null, listeners: null };

  const onPrompt = (msg) => {
    if (msg?.sessionId !== sessionId) return;
    // A blocked CLI is what the user is waiting on — apply it now, don't debounce it.
    entry.state = { ...entry.state, prompt: msg.prompt || null, stale: !!msg.stale, hasAgent: entry.state.hasAgent || !!msg.prompt };
    notify(entry);
    // Re-read for the option count: only the agent can see how many the menu really shows.
    if (msg.prompt) scheduleFetch(entry, socket, sessionId);
  };
  const onCleared = (msg) => {
    if (msg?.sessionId !== sessionId) return;
    entry.state = { ...entry.state, prompt: null, stale: false };
    notify(entry);
  };
  const onActivity = (msg) => {
    if (msg?.sessionId !== sessionId) return;
    scheduleFetch(entry, socket, sessionId);
  };
  // Live indicator from the screen: the spinner verb and an open selector, before the
  // transcript flushes. Applied immediately — it is small and human-visible.
  const onScreen = (msg) => {
    if (msg?.sessionId !== sessionId) return;
    entry.state = { ...entry.state, live: msg.live || null };
    notify(entry);
  };
  const onConnect = () => fetchNow(entry, socket, sessionId);

  entry.listeners = { onPrompt, onCleared, onActivity, onScreen, onConnect };
  socket.on(EVENTS.PROMPT, onPrompt);
  socket.on(EVENTS.PROMPT_CLEARED, onCleared);
  socket.on(EVENTS.ACTIVITY, onActivity);
  socket.on(EVENTS.SCREEN, onScreen);
  socket.on("connect", onConnect);

  entries.set(sessionId, entry);
  fetchNow(entry, socket, sessionId);
  return entry;
}

/** Start watching a session. Returns a handle to pass back to release(). */
export function acquire(socket, sessionId, onState) {
  if (!socket || !sessionId) return null;
  const entry = entries.get(sessionId) || createEntry(socket, sessionId);
  const handle = `h${++handleSeq}`;
  entry.subs.set(handle, onState);
  onState(entry.state);
  return handle;
}

export function release(socket, sessionId, handle) {
  if (!handle) return;
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.subs.delete(handle);
  if (entry.subs.size > 0) return;

  if (entry.timer) clearTimeout(entry.timer);
  const l = entry.listeners;
  if (socket && l) {
    socket.off(EVENTS.PROMPT, l.onPrompt);
    socket.off(EVENTS.PROMPT_CLEARED, l.onCleared);
    socket.off(EVENTS.ACTIVITY, l.onActivity);
    socket.off(EVENTS.SCREEN, l.onScreen);
    socket.off("connect", l.onConnect);
  }
  entries.delete(sessionId);
}

/** Force an immediate re-read — used after an action that changes what is on screen. */
export function refresh(socket, sessionId) {
  const entry = entries.get(sessionId);
  if (entry && socket) fetchNow(entry, socket, sessionId);
}

export function _entryCountForTest() { return entries.size; }
