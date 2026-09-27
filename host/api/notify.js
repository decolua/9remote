/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification } from "../features/terminal/pushManager.js";
import { applyEvent, STATES, TYPE_TO_STATE, setConversationId, getConversation, requestAutoName, scheduleDoneCommit } from "../features/terminal/statusManager.js";
import { sessionIdFromHookPayload, SESSION_ID_RE } from "../features/terminal/agentCatalog.js";
import { addNotification } from "../features/terminal/notificationManager.js";
import { onWorkerDone } from "../features/jarvis/jarvisWake.js";

const pushLastTime = {};
const PUSH_RATE_LIMIT_MS = 10000;
// Each CLI names its conversation id differently and the catalog owns the
// spelling, so a new CLI's hook needs no change here. `csid` is the flat form
// the shell hooks send; a plugin may post the CLI's own field name instead.
function conversationIdFrom(tool, params) {
  if (params?.csid && SESSION_ID_RE.test(params.csid)) return params.csid;
  const { sessionId: _terminalSessionId, ...ownFields } = params || {};
  return sessionIdFromHookPayload(tool, ownFields);
}

function parseNotifyParams(body, query) {
  if (query) {
    return {
      type: query.type || "stop",
      sessionId: query.sessionId || "",
      tool: query.tool || "",
      csid: query.csid || "",
      ...query,
    };
  }
  const data = JSON.parse(body || "{}");
  return {
    type: data.type || "stop",
    sessionId: data.sessionId || "",
    tool: data.tool || "",
    csid: data.csid || "",
    ...data,
  };
}

export async function handleNotifyPost(req, res) {
  let body = "";
  await new Promise((r) => { req.on("data", (c) => body += c); req.on("end", r); });
  try {
    dispatchNotify(parseNotifyParams(body, null));
    jsonOk(res, { success: true });
  } catch { jsonErr(res, 400, "Invalid JSON"); }
}

export function handleNotifyGet(req, res, { query }) {
  dispatchNotify(parseNotifyParams(null, query));
  jsonOk(res, { success: true });
}

function commitNotify(params, io, now) {
  const { type, sessionId, tool } = params;
  const notification = { type, sessionId, tool, timestamp: now };

  // State machine: applyEvent maps legacy type (stop/notification) and new (working/blocked/done).
  const entry = applyEvent({ type, sessionId, tool });
  const state = entry?.state || STATES.IDLE;

  // Type A — in-app badge + 4-state signal. chatNotification kept for legacy web clients.
  const conv = getConversation(sessionId);
  broadcast(io, "statusChange", { sessionId, state, tool, since: now, ...(conv ? { conversationId: conv.id } : {}) });
  addNotification(sessionId, notification);
  broadcast(io, "chatNotification", notification);

  // A finished turn is the moment the transcript holds a title, so it is also
  // when an auto-named terminal can take its conversation's name. `working`
  // fires on every tool call and teaches nothing new, so it is left out.
  if (state === STATES.DONE || state === STATES.BLOCKED) requestAutoName(sessionId);

  // The conductor cares about the same two moments: a worker finished, or one
  // is waiting on an answer. The wake itself debounces inside jarvisWake.
  if (state === STATES.DONE || state === STATES.BLOCKED) onWorkerDone(sessionId);

  // Type B — push to mobile: only for done/blocked (working would spam every tool call).
  // The SW's visible-window backstop suppresses the banner when a client is focused.
  // Rate-limit per session+state so two sessions finishing close together don't swallow each other.
  if (state !== STATES.DONE && state !== STATES.BLOCKED) return;
  const pushKey = `${sessionId}:${state}`;
  if (now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS) return;
  pushLastTime[pushKey] = now;

  sendPushNotification({ ...notification, state });
}

function dispatchNotify(params) {
  const { type, sessionId, tool } = params;
  const now = Date.now();
  const io = getIO();
  if (!io || !sessionId) return;

  // The CLI's own conversation id — stored before the broadcast below carries it
  const conversationId = conversationIdFrom(tool, params);
  if (conversationId) setConversationId(sessionId, tool, conversationId, "hook");

  // A done waits out its debounce window so the next turn's first hook can
  // cancel the flash; every other state commits now (and cancels it — applyEvent).
  if (TYPE_TO_STATE[type] === STATES.DONE) {
    scheduleDoneCommit(sessionId, () => commitNotify(params, io, Date.now()));
    return;
  }
  commitNotify(params, io, now);
}
