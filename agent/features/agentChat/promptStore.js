// What the AI CLI is currently blocked on, per pane, plus a rolling tool-call timeline.
// Fed by hook payloads. In-memory only: the TUI is the source of truth, this is a mirror.
import { PROMPT_KINDS, TOOL_KIND_MAP, MAX_ACTIVITY_ENTRIES, MAX_STORED_TEXT } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("agentChat");

const TRUNCATED = "\n… [truncated]";

// Keep the shape but cap the size: the GUI shows a preview, and the terminal view is
// always there for the full output.
function clampText(value) {
  if (typeof value !== "string") return value;
  return value.length > MAX_STORED_TEXT ? value.slice(0, MAX_STORED_TEXT) + TRUNCATED : value;
}

function clampInput(input) {
  if (!input || typeof input !== "object") return clampText(input);
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" ? clampText(v) : v;
  }
  return out;
}

// sessionId → { prompt, activity: [] }
const sessions = new Map();

let promptSeq = 0;

const getSession = (sessionId) => {
  let s = sessions.get(sessionId);
  if (!s) { s = { prompt: null, activity: [] }; sessions.set(sessionId, s); }
  return s;
};

// Classify by tool_name, NOT by event name — newer Claude reports an AskUserQuestion
// wait as a PermissionRequest, so the event name alone would mislabel it.
const kindOf = (toolName) => TOOL_KIND_MAP[toolName] || PROMPT_KINDS.PERMISSION;

// Identity of a prompt as the user sees it — a re-fired identical hook must not
// invalidate the card they are currently reading.
const promptFingerprint = (toolName, toolInput) => `${toolName}|${JSON.stringify(toolInput ?? null)}`;

// Events that can announce a wait. PreToolUse counts only for inherently interactive tools
// (question/plan), which block on the tool call itself rather than a separate permission event.
const PRE_EVENTS = new Set(["PermissionRequest", "Notification", "PreToolUse"]);
const isPromptEvent = (event, toolName) => {
  if (!PRE_EVENTS.has(event)) return false;
  if (event !== "PreToolUse") return true;
  return kindOf(toolName) !== PROMPT_KINDS.PERMISSION;
};

function setPrompt(session, { toolName, toolInput, tool, launchToken }) {
  const fingerprint = promptFingerprint(toolName, toolInput);
  if (session.prompt?.fingerprint === fingerprint) return session.prompt;
  session.prompt = {
    promptId: `p${++promptSeq}-${Date.now()}`,
    kind: kindOf(toolName),
    toolName,
    toolInput: clampInput(toolInput) ?? null,
    tool: tool || null,
    launchToken: launchToken || null,
    fingerprint,
    receivedAt: Date.now(),
  };
  return session.prompt;
}

// A pending prompt is resolved when the very tool it gates actually runs or the turn ends.
// Questions are weaker: Claude fires no hook after the user answers, so any following tool
// work is taken as the answer. Permission cards are sticky — a stray unrelated event must
// not silently dismiss "allow rm -rf?".
function maybeClearPrompt(session, { event, toolName }) {
  const prompt = session.prompt;
  if (!prompt) return;
  if (event === "Stop" || event === "SessionEnd") { session.prompt = null; return; }
  if (toolName && toolName === prompt.toolName && (event === "PostToolUse" || event === "PostToolUseFailure")) {
    session.prompt = null;
    return;
  }
  if (prompt.kind === PROMPT_KINDS.QUESTION && toolName && toolName !== prompt.toolName) {
    session.prompt = null;
  }
}

function pushActivity(session, entry) {
  session.activity.push(entry);
  if (session.activity.length > MAX_ACTIVITY_ENTRIES) {
    session.activity.splice(0, session.activity.length - MAX_ACTIVITY_ENTRIES);
  }
}

function recordActivity(session, { event, toolName, toolInput, toolResponse, prompt }) {
  if (event === "UserPromptSubmit") {
    // The prompt text is the ONLY thing that makes the user's own turn visible in the
    // chat view — log when it is missing, or the row silently renders blank.
    if (!prompt) logger.debug("UserPromptSubmit arrived with no `prompt` field — the user row will be empty");
    pushActivity(session, { kind: "userPrompt", text: clampText(prompt || ""), at: Date.now() });
    return;
  }
  if (event === "PreToolUse" && toolName) {
    pushActivity(session, { kind: "tool", toolName, toolInput: clampInput(toolInput) ?? null, status: "running", at: Date.now() });
    return;
  }
  if ((event === "PostToolUse" || event === "PostToolUseFailure") && toolName) {
    const status = event === "PostToolUseFailure" ? "error" : "done";
    // Match the newest still-open call of this tool so concurrent tools settle independently.
    for (let i = session.activity.length - 1; i >= 0; i--) {
      const e = session.activity[i];
      if (e.kind === "tool" && e.toolName === toolName && e.status === "running") {
        e.status = status;
        e.toolResponse = clampText(toolResponse) ?? null;
        e.doneAt = Date.now();
        return;
      }
    }
    pushActivity(session, { kind: "tool", toolName, toolInput: null, toolResponse: clampText(toolResponse) ?? null, status, at: Date.now(), doneAt: Date.now() });
  }
}

/** Feed one hook event. Returns { prompt, promptChanged, activityChanged } for the socket layer. */
export function ingestHookEvent({ sessionId, tool, event, launchToken, payload } = {}) {
  if (!sessionId) return { prompt: null, promptChanged: false, activityChanged: false };
  const session = getSession(sessionId);
  const p = payload || {};
  const toolName = p.tool_name || null;

  const before = session.prompt;
  const activityBefore = session.activity.length;

  recordActivity(session, {
    event, toolName, toolInput: p.tool_input, toolResponse: p.tool_response, prompt: p.prompt,
  });

  if (toolName && isPromptEvent(event, toolName)) setPrompt(session, { toolName, toolInput: p.tool_input, tool, launchToken });
  else maybeClearPrompt(session, { event, toolName });

  return {
    prompt: session.prompt,
    promptChanged: before !== session.prompt,
    // Stop matters even though it adds no row: it is when the assistant's closing prose
    // lands in the transcript, and the chat view has no other way to learn about it.
    activityChanged: session.activity.length !== activityBefore
      || event === "PostToolUse" || event === "PostToolUseFailure" || event === "Stop",
  };
}

export function getPrompt(sessionId) {
  return sessions.get(sessionId)?.prompt || null;
}

export function clearPrompt(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.prompt = null;
}

export function getActivity(sessionId) {
  return sessions.get(sessionId)?.activity || [];
}

export function getSnapshot(sessionId) {
  const s = sessions.get(sessionId);
  return { prompt: s?.prompt || null, activity: s?.activity || [] };
}

export function resetSession(sessionId) {
  sessions.delete(sessionId);
}

export function _resetAllForTest() {
  sessions.clear();
  promptSeq = 0;
}
