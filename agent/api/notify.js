/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification, hasPushSubscriptions } from "../features/terminal/pushManager.js";
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

  // Type B — push to mobile app: only when a device has enabled push (subscribed) and app isn't focused
  if (!hasPushSubscriptions()) return;
  const pushKey = `${tool}:${type}`;
  if (now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS) return;
  pushLastTime[pushKey] = now;

  io.timeout(5000).emit("chatNotificationAck", notification, (err, responses) => {
    const hasFocused = !err && responses && responses.length > 0;
    if (!hasFocused) sendPushNotification(notification);
  });
}
