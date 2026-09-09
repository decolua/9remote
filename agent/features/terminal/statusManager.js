// AI agent status state machine (idle / working / blocked / done).
// Replaces the old binary notificationManager. One session = one state.
// State is in-memory and resets on agent restart; hooks re-fire working on the
// next prompt. The conversation each terminal runs is the exception: the PTY
// outlives the agent (it lives in the daemon), so the link to it is persisted
// alongside the session metadata and replayed on boot.

import { SESSION_ID_RE, isShellProcess, agentIdFromProcess } from "./agentCatalog.js";

export const STATES = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  BLOCKED: "blocked",
  DONE: "done",
});

// A working session is considered live while either hook events or PTY output keeps arriving.
// Reaper clears entries idle beyond this TTL so a crashed/stuck agent can't pin "working" forever.
export const WORKING_TTL_MS = 60_000;
const REAPER_INTERVAL_MS = 15_000;

// Back-compat: legacy hook event types from /api/notify → internal state.
export const TYPE_TO_STATE = Object.freeze({
  stop: STATES.DONE,
  notification: STATES.BLOCKED,
  working: STATES.WORKING,
  done: STATES.DONE,
  blocked: STATES.BLOCKED,
  idle: STATES.IDLE,
});

// sessionStatus: Map<sessionId, { state, tool, since, message? }>
const sessionStatus = new Map();
const clearCallbacks = new Set();

// The agent conversation each 9Remote terminal is running: sessionId ->
// { agent, id, source }. Kept apart from the state map so the reaper can't clear
// it — it powers exact resume and "this chat is already open in that terminal".
//
// Three sources, in descending trust. `hook` is the CLI telling us its own id.
// `resume` is a conversation we relaunched ourselves, so we typed the id. `prompt`
// is inference from a transcript's opening prompt. A weaker source never
// overwrites a stronger one; a stronger one corrects a weaker one.
const CONVERSATION_SOURCE_RANK = { hook: 3, resume: 2, prompt: 1 };
const conversations = new Map();
// Declared with the conversation it belongs to: both are cleared by the same
// teardown paths above, which run before the prompt setters further down.
const lastPrompts = new Map();
// Set by the terminal layer: a conversation that only ever lived in memory is
// lost on the next restart, and hooks fire far more often than sessions are
// created, so the write has to hang off the change itself.
let onConversationChange = null;
// Replaying disk state is not news; writing during it would persist a session
// map that boot is still rebuilding, one entry at a time.
let replaying = false;

export function setConversationPersister(fn) {
  onConversationChange = fn;
}

function persistConversation(sessionId) {
  if (replaying) return;
  try { onConversationChange?.(sessionId); } catch {}
}

export function setConversationId(sessionId, agent, id, source = "hook") {
  if (!sessionId || !agent || !id) return;
  const rank = CONVERSATION_SOURCE_RANK[source] || 0;
  if (!rank) return;
  const prev = conversations.get(sessionId);
  // A weaker source may not overrule a stronger one about the same CLI — but a
  // different CLI is not a disagreement, it means the terminal moved on.
  if (prev && prev.agent === agent && rank < (CONVERSATION_SOURCE_RANK[prev.source] || 0)) return;
  // Nothing learned: same CLI, same conversation, same confidence. A change of
  // source alone still counts — a guess later confirmed by a hook must reach
  // disk as confirmed, or the restart replays it as proof it never was.
  if (prev && prev.agent === agent && prev.id === id && prev.source === source) return;
  conversations.set(sessionId, { agent, id, source });
  persistConversation(sessionId);
}

export function getConversation(sessionId) {
  return conversations.get(sessionId) || null;
}

export function clearConversation(sessionId) {
  if (sessionId) conversations.delete(sessionId);
}

/** Every terminal's live conversation, for matching history rows against them. */
export function getLiveConversations() {
  const out = [];
  for (const [sessionId, conv] of conversations) {
    out.push({ sessionId, agent: conv.agent, conversationId: conv.id });
  }
  // Terminals whose agent is known but whose conversation is not: still worth
  // offering to the prompt matcher, which is the only signal they have.
  for (const [sessionId, agent] of sessionAgents) {
    if (conversations.has(sessionId)) continue;
    out.push({ sessionId, agent, prompt: getLastPrompt(sessionId) });
  }
  return out;
}

// Agent CLI per session detected without hooks (typed launch line or OSC title).
// Fills `tool` only where no hook entry provided one; hook events stay authoritative.
const sessionAgents = new Map();
const agentChangeCallbacks = new Set();

export function setSessionAgent(sessionId, agentId) {
  if (!sessionId || !agentId || sessionAgents.get(sessionId) === agentId) return;
  sessionAgents.set(sessionId, agentId);
  // A different CLI is now running here, so whatever chat the last one held is
  // not open in this terminal any more.
  const prev = conversations.get(sessionId);
  if (prev && prev.agent !== agentId) { conversations.delete(sessionId); lastPrompts.delete(sessionId); }
  // Persisted alongside the conversation: a CLI whose hooks report no id is
  // known only by this, and the fallbacks all key off knowing which agent runs.
  persistConversation(sessionId);
  for (const cb of agentChangeCallbacks) { try { cb(sessionId, agentId); } catch {} }
}

export function getSessionAgent(sessionId) {
  return sessionAgents.get(sessionId) || null;
}

// The agent stopped, but the terminal is still there — a TUI that exited leaves
// a bare shell. Its conversation ends with it: nothing is running that chat.
export function clearSessionAgent(sessionId) {
  if (!sessionId) return;
  sessionAgents.delete(sessionId);
  conversations.delete(sessionId);
  lastPrompts.delete(sessionId);
  sessionStatus.delete(sessionId);
}

/**
 * Handle foreground process change for a session.
 * Preserves DONE or BLOCKED state so completion badges are not wiped when returning to shell.
 */
export function onProcessChange(sessionId, procName) {
  if (!sessionId || !procName) return null;
  if (isShellProcess(procName)) {
    const status = getStatus(sessionId);
    // Preserving DONE or BLOCKED: when a task finishes and returns to shell,
    // the completion badge must remain until the user focuses or inputs.
    if (status && (status.state === STATES.DONE || status.state === STATES.BLOCKED)) {
      return null;
    }
    const current = getSessionAgent(sessionId) || status?.tool || getConversation(sessionId)?.agent;
    if (current || (status && status.state === STATES.WORKING)) {
      clearSessionAgent(sessionId);
      clearStatus(sessionId);
      return { state: STATES.IDLE, tool: null, conversationId: null };
    }
    return null;
  }
  const agentId = agentIdFromProcess(procName);
  if (agentId) {
    setSessionAgent(sessionId, agentId);
    return { agentId };
  }
  return null;
}

/**
 * Attach a conversation to a terminal we are resuming it into. The id came from
 * the history row we just typed a resume line for, so it is known before the CLI
 * has said anything — waiting for the first hook would leave the terminal
 * unlinked from the very chat it is resuming until the user sends a message.
 */
export function claimResumedConversation(sessionId, row) {
  const agent = row?.agent;
  const id = row?.sessionId;
  if (!sessionId || !agent || !id || !SESSION_ID_RE.test(id)) return;
  // The agent first: setSessionAgent clears a conversation belonging to another
  // CLI, which would drop the one being set here if it ran the other way round.
  setSessionAgent(sessionId, agent);
  setConversationId(sessionId, agent, id, "resume");
}

// A terminal's name may now be knowable — the CLI just finished a turn, so its
// transcript holds a title. Kept as a subscription because the naming itself
// lives in the terminal layer, which this module must not import.
const autoNameCallbacks = new Set();

export function onAutoNameRequest(fn) {
  autoNameCallbacks.add(fn);
  return () => autoNameCallbacks.delete(fn);
}

export function requestAutoName(sessionId) {
  if (!sessionId) return;
  for (const cb of autoNameCallbacks) { try { cb(sessionId); } catch {} }
}

/**
 * What this terminal's conversation looks like on disk. The PTY survives an
 * agent restart (it lives in the daemon), so this must too — otherwise every
 * restart silently unlinks running chats from the terminals running them.
 */
export function conversationMetadata(sessionId) {
  const agent = sessionAgents.get(sessionId);
  const conv = conversations.get(sessionId);
  if (!agent && !conv) return null;
  if (!conv) return { agent };
  return { agent: conv.agent, conversationId: conv.id, conversationSource: conv.source };
}

/**
 * Replay one terminal's persisted conversation on boot. The id is validated the
 * same way one arriving over the wire is: it was written by us, but it still
 * ends up typed into a PTY, and a file is not a trust boundary.
 */
export function restoreConversation(sessionId, metadata) {
  const agent = metadata?.agent;
  if (!sessionId || !agent) return;
  replaying = true;
  try {
    replayConversation(sessionId, agent, metadata);
  } finally {
    replaying = false;
  }
}

function replayConversation(sessionId, agent, metadata) {
  setSessionAgent(sessionId, agent);
  const id = metadata.conversationId;
  if (!id || !SESSION_ID_RE.test(id)) return;
  // An older agent persisted no source. Restoring it as a hook would launder a
  // guess into proof and then lock out the live hook that could correct it, so
  // an unlabelled id comes back at the weakest confidence.
  setConversationId(sessionId, agent, id, metadata.conversationSource || "prompt");
}

/**
 * The terminal itself is gone. Every teardown path calls this — session ids are
 * minted from a timestamp, so anything left behind is not merely stale, it is
 * inherited by whichever session id lands on the same value next.
 */
export function forgetSession(sessionId) {
  if (!sessionId) return;
  clearSessionAgent(sessionId);
  sessionStatus.delete(sessionId);
}

// The last line the user typed into a running TUI agent — the closest thing to
// "the prompt this conversation opened with" that exists without a hook. Only
// clean printable text is kept: arrow keys, slash commands and shell lines are
// not prompts, and a wrong prompt is worse than none (it feeds the matcher).
const PROMPT_MAX = 200;
// Built via new RegExp so PROMPT_MAX can size the quantifier — a regex literal
// cannot interpolate, and a literal "{1,PROMPT_MAX - 1}" silently never matches.
const PROMPT_OK_RE = new RegExp(`^[^\\u0000-\\u001f\\u007f/][^\\u0000-\\u001f\\u007f;&|<>$\`]{1,${PROMPT_MAX - 1}}$`);

export function setLastPrompt(sessionId, line) {
  // Only a terminal with a TUI agent running has prompts; in a plain shell the
  // entered line is a command, and storing it would feed the matcher a lie.
  if (!sessionId || !sessionAgents.has(sessionId)) return;
  const text = String(line || "").trim();
  if (!PROMPT_OK_RE.test(text)) return;
  lastPrompts.set(sessionId, text);
}

export function getLastPrompt(sessionId) {
  return lastPrompts.get(sessionId) || "";
}

export function onAgentChange(cb) {
  agentChangeCallbacks.add(cb);
  return () => agentChangeCallbacks.delete(cb);
}

export function applyEvent({ type, sessionId, tool, message } = {}) {
  if (!sessionId) return null;
  const state = TYPE_TO_STATE[type] || STATES.IDLE;
  const prev = sessionStatus.get(sessionId);

  // done only makes sense after working/blocked — ignore a stray done on idle
  if (state === STATES.DONE && (!prev || prev.state === STATES.IDLE)) return prev || null;

  // No-op transition: keep timestamp, avoid spurious broadcasts.
  if (prev && prev.state === state && prev.tool === tool) return prev;

  const entry = {
    state, tool: tool || prev?.tool, since: Date.now(), message: message ?? undefined,
    ...(state === STATES.WORKING ? { expiresAt: Date.now() + WORKING_TTL_MS } : {}),
  };
  sessionStatus.set(sessionId, entry);
  return entry;
}

export function setStatus(sessionId, entry) {
  if (!sessionId) return;
  if (!entry) { sessionStatus.delete(sessionId); return; }
  const meta = { ...entry, since: Date.now() };
  if (meta.state === STATES.WORKING) meta.expiresAt = Date.now() + WORKING_TTL_MS;
  sessionStatus.set(sessionId, meta);
}

// Refresh the working TTL — called on live PTY output so a thinking/streaming agent
// is never reaped while it's still producing. No-op for non-working sessions.
export function touchWorking(sessionId) {
  if (!sessionId) return;
  const entry = sessionStatus.get(sessionId);
  if (entry?.state !== STATES.WORKING) return;
  entry.expiresAt = Date.now() + WORKING_TTL_MS;
}

// Periodically drop working entries whose TTL expired (agent crashed / hook never fired).
// broadcast(sessionId) is invoked per cleared session so clients flip back to idle.
export function startReaper(broadcast) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessionStatus) {
      if (entry.state !== STATES.WORKING) continue;
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        sessionStatus.delete(id);
        if (typeof broadcast === "function") { try { broadcast(id); } catch {} }
      }
    }
  }, REAPER_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

export function getStatus(sessionId) {
  return sessionStatus.get(sessionId) || null;
}

export function getStatuses() {
  const out = {};
  for (const [id, entry] of sessionStatus) out[id] = entry;
  // Attach conversation ids for sessions with no live state entry too (idle tab)
  for (const [id, conv] of conversations) {
    const extra = { conversationId: conv.id, tool: conv.agent };
    out[id] = out[id] ? { ...extra, ...out[id], conversationId: conv.id } : extra;
  }
  // Hookless detection fills tool only where no hook entry provided one
  for (const [id, agentId] of sessionAgents) {
    if (!out[id]) out[id] = { tool: agentId };
    else if (!out[id].tool) out[id] = { ...out[id], tool: agentId };
  }
  return out;
}

export function clearStatus(sessionId) {
  if (!sessionId) return false;
  const entry = sessionStatus.get(sessionId);
  // Only clear DONE (mark as seen → idle). working/blocked stay — focusing or typing into a
  // running/blocked pane does not stop the agent or resolve its pending input.
  if (!entry || entry.state !== STATES.DONE) return false;
  sessionStatus.delete(sessionId);
  for (const cb of clearCallbacks) { try { cb(sessionId); } catch {} }
  return true;
}

export function onClearStatus(cb) {
  clearCallbacks.add(cb);
  return () => clearCallbacks.delete(cb);
}

// Back-compat shim for notificationManager.addNotification / getNotifications callers.
export function addNotification(sessionId, notification) {
  if (!sessionId || !notification) return;
  applyEvent({ type: notification.type, sessionId, tool: notification.tool });
}
export function getNotifications() {
  // Legacy UI checked truthiness of notifications[id]; expose done/blocked as truthy.
  const out = {};
  for (const [id, entry] of sessionStatus) {
    if (entry.state === STATES.DONE || entry.state === STATES.BLOCKED) {
      out[id] = { sessionId: id, type: entry.state, tool: entry.tool, timestamp: entry.since };
    }
  }
  return out;
}
export function clearNotification(sessionId) { clearStatus(sessionId); }
