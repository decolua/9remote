/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification } from "../features/terminal/pushManager.js";
import { applyEvent, STATES } from "../features/terminal/statusManager.js";
import { addNotification } from "../features/terminal/notificationManager.js";

const pushLastTime = {};
const PUSH_RATE_LIMIT_MS = 10000;

function parseNotifyParams(body, query) {
  if (query) {
    return {
      type: query.type || "stop",
      sessionId: query.sessionId || "",
      tool: query.tool || "claude",
    };
  }
  const data = JSON.parse(body || "{}");
  return {
    type: data.type || "stop",
    sessionId: data.sessionId || "",
    tool: data.tool || "claude",
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

function dispatchNotify({ type, sessionId, tool }) {
  const now = Date.now();
  const io = getIO();
  if (!io || !sessionId) return;

  const notification = { type, sessionId, tool, timestamp: now };

  // State machine: applyEvent maps legacy type (stop/notification) and new (working/blocked/done).
  const entry = applyEvent({ type, sessionId, tool });
  const state = entry?.state || STATES.IDLE;

  // Type A — in-app badge + 4-state signal. chatNotification kept for legacy web clients.
  broadcast(io, "statusChange", { sessionId, state, tool, since: now });
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
