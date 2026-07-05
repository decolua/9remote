/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification, shouldPush } from "../features/terminal/pushManager.js";
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

  // Type A — in-app badge (agent + web UI): always sent, no conditions
  addNotification(sessionId, notification);
  broadcast(io, "chatNotification", notification);

  // Type B — push to mobile app: send whenever the app isn't foregrounded.
  // WebPush/Expo delivers to a closed PWA without a live socket, so we must NOT
  // gate on socket connectivity — only skip when the app is connected AND focused.
  if (!shouldPush()) return;
  // Rate-limit per session (not per tool:type) so two sessions finishing close
  // together don't swallow each other's push.
  const pushKey = `${sessionId}:${type}`;
  if (now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS) return;
  pushLastTime[pushKey] = now;

  sendPushNotification(notification);
}
