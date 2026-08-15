/**
 * Notification handler (public — called by AI hooks)
 */

import { jsonOk } from "../lib/router.js";
import { getIO } from "../transport/server.js";
import { broadcast } from "../transport/broadcast.js";
import { sendPushNotification } from "../features/terminal/pushManager.js";
import { applyEvent, STATES } from "../features/terminal/statusManager.js";
import { addNotification } from "../features/terminal/notificationManager.js";
import { recordHookEvent, isLaunchTokenCurrent } from "../features/terminal/agentSessionMap.js";
import { ingestHookEvent } from "../features/agentChat/promptStore.js";
import { EVENTS } from "../features/agentChat/constants.js";
import { traceHook, getHookTrace, clearHookTrace } from "../features/agentChat/hookTrace.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("agentChat");

const pushLastTime = {};
const PUSH_RATE_LIMIT_MS = 10000;

// Mapping-only hook: it tells us which CLI session owns the pane, but says nothing
// about whether the agent is busy — never let it reset a live status.
const MAPPING_ONLY_EVENTS = new Set(["SessionStart"]);

function parseNotifyParams(body, query) {
  const q = query || {};
  let payload = null;
  if (body) {
    // Hook payloads are best-effort — a body we cannot parse must not fail the request.
    try { payload = JSON.parse(body); } catch { payload = null; }
  }
  return {
    type: q.type || payload?.type || "stop",
    sessionId: q.sessionId || payload?.sessionId || "",
    tool: q.tool || payload?.tool || "claude",
    // hook_event_name from the payload is authoritative; the query carries it as a fallback
    // for hook formats that cannot forward stdin.
    event: payload?.hook_event_name || q.event || null,
    launchToken: q.launchToken || payload?.launchToken || null,
    payload,
  };
}

export async function handleNotifyPost(req, res, ctx) {
  let body = "";
  await new Promise((r) => { req.on("data", (c) => body += c); req.on("end", r); });
  const query = ctx?.query || null;
  let parsed = null;
  // Fail open: always ack so a malformed payload never blocks the AI CLI.
  try {
    parsed = parseNotifyParams(body, query);
    dispatchNotify(parsed, { method: "POST", query, rawBody: body });
  } catch (e) {
    logger.error(`notify POST threw: ${e.message}`);
    traceHook({ method: "POST", query, rawBody: body, parsed, outcome: "threw", detail: e.message });
  }
  jsonOk(res, { success: true });
}

export function handleNotifyGet(req, res, { query }) {
  let parsed = null;
  try {
    parsed = parseNotifyParams(null, query);
    dispatchNotify(parsed, { method: "GET", query, rawBody: "" });
  } catch (e) {
    logger.error(`notify GET threw: ${e.message}`);
    traceHook({ method: "GET", query, rawBody: "", parsed, outcome: "threw", detail: e.message });
  }
  jsonOk(res, { success: true });
}

/** Recent hook calls with their raw bodies — answers "did it arrive, and what did it carry?". */
export function handleNotifyDebugGet(req, res, { query } = {}) {
  if (query?.clear === "1") {
    clearHookTrace();
    return jsonOk(res, { success: true, cleared: true });
  }
  jsonOk(res, { success: true, trace: getHookTrace() });
}

function dispatchNotify({ type, sessionId, tool, event, launchToken, payload }, traceCtx = {}) {
  const now = Date.now();
  const parsed = { type, sessionId, tool, event, launchToken, payload };
  const trace = (outcome, detail) => traceHook({ ...traceCtx, parsed, outcome, detail });

  if (!sessionId) {
    logger.debug(`drop: no sessionId (event=${event || "?"} tool=${tool})`);
    trace("dropped", "no sessionId");
    return;
  }

  // A nested agent inherits the pane's env vars. Its events would otherwise overwrite the
  // parent's status and session mapping, so drop everything from a foreign launch token.
  if (!isLaunchTokenCurrent(sessionId, launchToken)) {
    logger.debug(`drop: foreign launchToken ${launchToken} on ${sessionId} (event=${event})`);
    trace("dropped", `foreign launchToken ${launchToken}`);
    return;
  }

  const io = getIO();
  const promptChars = typeof payload?.prompt === "string" ? payload.prompt.length : null;
  logger.debug(
    `hook event=${event || "?"} tool=${tool} session=${sessionId} ` +
    `payload=${payload ? "yes" : "NO"} toolName=${payload?.tool_name || "-"} promptChars=${promptChars ?? "-"} io=${io ? "up" : "none"}`
  );

  // Record before checking for listeners: the CLI runs whether or not a browser is
  // attached, and dropping these would leave the chat view blank on the next connect.
  if (payload) {
    recordHookEvent({ sessionId, tool, event, launchToken, payload });
    const result = ingestHookEvent({ sessionId, tool, event, launchToken, payload });
    logger.debug(`ingest promptChanged=${result.promptChanged} activityChanged=${result.activityChanged} kind=${result.prompt?.kind || "-"}`);
    trace("ingested", `promptChanged=${result.promptChanged} activityChanged=${result.activityChanged}`);
    if (io) {
      if (result.promptChanged) {
        broadcast(io, result.prompt ? EVENTS.PROMPT : EVENTS.PROMPT_CLEARED, { sessionId, prompt: result.prompt });
      }
      if (result.activityChanged) broadcast(io, EVENTS.ACTIVITY, { sessionId });
    }
  } else {
    // A hook that fired but forwarded nothing: the chat view can only show a status light.
    logger.debug(`hook ${event || "?"} arrived with NO payload — query-only call`);
    trace("noPayload", "body was empty or unparseable");
  }

  if (MAPPING_ONLY_EVENTS.has(event)) return;

  const notification = { type, sessionId, tool, timestamp: now };

  // State machine: applyEvent maps legacy type (stop/notification) and new (working/blocked/done).
  const entry = applyEvent({ type, sessionId, tool });
  const state = entry?.state || STATES.IDLE;

  // Type A — in-app badge + 4-state signal. chatNotification kept for legacy web clients.
  addNotification(sessionId, notification);
  if (io) {
    broadcast(io, "statusChange", { sessionId, state, tool, since: now });
    broadcast(io, "chatNotification", notification);
  }

  // Type B — push to mobile: only for done/blocked (working would spam every tool call).
  // The SW's visible-window backstop suppresses the banner when a client is focused.
  // Rate-limit per session+state so two sessions finishing close together don't swallow each other.
  if (state !== STATES.DONE && state !== STATES.BLOCKED) return;
  const pushKey = `${sessionId}:${state}`;
  if (now - (pushLastTime[pushKey] || 0) < PUSH_RATE_LIMIT_MS) return;
  pushLastTime[pushKey] = now;

  sendPushNotification({ ...notification, state });
}
