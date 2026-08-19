/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification } from "../features/terminal/pushManager.js";
import { applyEvent, STATES, setClaudeSessionId, getClaudeSessionId } from "../features/terminal/statusManager.js";
import { addNotification } from "../features/terminal/notificationManager.js";

const pushLastTime = {};
const PUSH_RATE_LIMIT_MS = 10000;
// Claude session ids are uuid-like; this endpoint is localhost-public, so anything
// else would later be typed into the user's PTY by the resume flow.
const CLAUDE_SESSION_ID_RE = /^[0-9a-f-]{1,64}$/i;

function parseNotifyParams(body, query) {
  if (query) {
    return {
      type: query.type || "stop",
      sessionId: query.sessionId || "",
      tool: query.tool || "claude",
      csid: query.csid || "",
    };
  }
  const data = JSON.parse(body || "{}");
  return {
    type: data.type || "stop",
    sessionId: data.sessionId || "",
    tool: data.tool || "claude",
    csid: data.csid || "",
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

function dispatchNotify({ type, sessionId, tool, csid }) {
  const now = Date.now();
  const io = getIO();
  if (!io || !sessionId) return;

  // Claude conversation id from the hook — stored before the broadcast below carries it
  if (csid && CLAUDE_SESSION_ID_RE.test(csid)) setClaudeSessionId(sessionId, csid);

  const notification = { type, sessionId, tool, timestamp: now };

  // State machine: applyEvent maps legacy type (stop/notification) and new (working/blocked/done).
  const entry = applyEvent({ type, sessionId, tool });
  const state = entry?.state || STATES.IDLE;

  // Type A — in-app badge + 4-state signal. chatNotification kept for legacy web clients.
  broadcast(io, "statusChange", { sessionId, state, tool, since: now, ...(getClaudeSessionId(sessionId) ? { claudeSessionId: getClaudeSessionId(sessionId) } : {}) });
  addNotification(sessionId, notification);
  broadcast(io, "chatNotification", notification);

  // Type B — push to mobile: only for done/blocked (working would spam every tool call).
  // The SW's visible-window backstop suppresses the banner when a client is focused.
  // Rate-limit per session+state so two sessions finishing close together don't swallow each other.
  if (state !== STATES.DONE && state !== STATES.BLOCKED) return;
  const pushKey = `${sessionId}:${state}`;
  if (now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS) return;
  pushLastTime[pushKey] = now;

  sendPushNotification({ ...notification, state });
}
