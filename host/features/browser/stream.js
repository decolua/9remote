import {
  KEY_CODES,
  STREAM_EVERY_NTH,
  STREAM_INPUT_BATCH_MAX,
  STREAM_MAX_EDGE,
  STREAM_MIN_INTERVAL_MS,
  STREAM_QUALITY
} from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("browserStream");
const DIAG = process.env.NODE_ENV !== "production";

const streams = new Map();
// Last frame per tab, kept across stop/start so a reconnecting pane paints
// instantly instead of staring at a black stage until the next repaint.
const lastFrames = new Map();
const LAST_FRAMES_MAX = 8;

// Touch batch normalization — max 5 fingers, numbers clamped.
export function cdpTouchPoints(points) {
  return (Array.isArray(points) ? points : []).slice(0, 5)
    .map((p) => ({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 }));
}

export function clampViewport(raw = {}) {
  const num = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, STREAM_MAX_EDGE) : fallback;
  };
  const scale = Math.min(2, Math.max(1, Number(raw.scale) || 1));
  return { width: num(raw.width, 720), height: num(raw.height, 1280), scale };
}

export function frameAdmitted(lastSentAt, now, minIntervalMs = STREAM_MIN_INTERVAL_MS) {
  return now - lastSentAt >= minIntervalMs;
}

export async function startStream(client, targetId, viewport, emit) {
  const id = String(targetId || "");
  if (!id) throw new Error("Missing field: targetId");
  if (streams.has(id)) await stopStream(id);

  const attached = await client.call("Target.attachToTarget", { targetId: id, flatten: true });
  const sessionId = attached.sessionId;
  const detach = () => client.call("Target.detachFromTarget", { sessionId }).catch(() => {});

  const size = clampViewport(viewport);
  const record = {
    client, sessionId, detach, emit,
    seq: 0, lastSentAt: 0, stopped: false
  };

  const onFrame = (params, evSessionId) => {
    if (record.stopped || evSessionId !== record.sessionId) return;
    handleFrame(record, id, params);
  };

  record.offEvent = client.on("Page.screencastFrame", onFrame);
  streams.set(id, record);

  try {
    // Page.* events (screencastFrame) only flow on a session with the domain
    // enabled — without this Chrome emits the first frame or two and goes quiet.
    await client.call("Page.enable", {}, sessionId);
    // Resize the headless WINDOW itself to the pane's stage — the compositor
    // surface follows the window, and a stale window size letterboxes/shrinks
    // the stream no matter what the viewport override says.
    try {
      const { windowId } = await client.call("Target.getWindowForTarget", { targetId: id });
      await client.call("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal", width: size.width, height: size.height }
      });
    } catch { /* best-effort; the override below still pins the viewport */ }
    // Lock the viewport to the requested size — without this Chrome keeps its
    // own (window chrome eats ~90px) and every input coordinate lands offset.
    // dsf stays 1 here: raster density comes from the launch flag
    // (--force-device-scale-factor) and screencast maxWidth scales it per client.
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    await client.call("Page.startScreencast", {
      format: "jpeg",
      quality: STREAM_QUALITY,
      maxWidth: Math.round(size.width * size.scale),
      maxHeight: Math.round(size.height * size.scale),
      everyNthFrame: STREAM_EVERY_NTH
    }, sessionId);
  } catch (e) {
    await stopStream(id);
    throw e;
  }

  // Paint the cached frame immediately; a static page emits nothing until it
  // repaints, which otherwise reads as a dead stream right after connect.
  const cached = lastFrames.get(id);
  if (cached) {
    record.emit(cached);
  } else {
    // Nudge a repaint so the very first frame arrives without waiting for one.
    client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 }, sessionId)
      .catch(() => {});
  }

  return { targetId: id, ...size };

}

export async function stopStream(targetId) {
  const id = String(targetId || "");
  const record = streams.get(id);
  if (!record) return { stopped: id };
  record.stopped = true;
  streams.delete(id);
  record.offEvent?.();
  await record.client.call("Page.stopScreencast", {}, record.sessionId).catch(() => {});
  await record.detach?.();
  return { stopped: id };
}

function cdpAck(record, frameSessionId, via) {
  // UNCONDITIONAL, like the POC: Chrome stalls its screencast queue the moment
  // any received frame goes unacked — admission pacing below only decides what
  // we forward, never whether Chrome may keep producing.
  // The ack's param is the FRAME's own sessionId (a counter), NOT the attach
  // session — passing the attach session makes Chrome drop every ack and the
  // screencast dies after the first couple of frames.
  if (DIAG && via !== "skip") logger.info(`TEMP DIAGNOSTIC ack frame=${frameSessionId} via=${via}`);
  record.client.call("Page.screencastFrameAck", { sessionId: frameSessionId }, record.sessionId)
    .catch(() => {});
}

function handleFrame(record, targetId, params) {
  const now = Date.now();
  const admitted = frameAdmitted(record.lastSentAt, now);
  if (admitted) record.lastSentAt = now;

  let payload = null;
  if (admitted) {
    record.seq += 1;
    const m = params.metadata || {};
    payload = {
      targetId,
      seq: record.seq,
      image: params.data,
      meta: {
        deviceWidth: m.deviceWidth,
        deviceHeight: m.deviceHeight,
        scrollX: m.scrollOffsetX,
        scrollY: m.scrollOffsetY,
        scale: m.pageScaleFactor,
        offsetTop: m.offsetTop
      }
    };
    if (lastFrames.size >= LAST_FRAMES_MAX) lastFrames.delete(lastFrames.keys().next().value);
    lastFrames.set(targetId, payload);
    if (DIAG) logger.info(`TEMP DIAGNOSTIC frame seq=${record.seq} b64=${params.data?.length}`);
  }
  // Ack first — emit after, so a slow broadcast can never delay the ack.
  cdpAck(record, params.sessionId, admitted ? "sent" : "skip");
  if (payload) record.emit(payload);
}

export function ackFrame(targetId, seq) {
  // Client acks are informational now (host acks Chrome directly); kept for the
  // diagnostic trail and forward-compat.
  if (DIAG) logger.info(`TEMP DIAGNOSTIC client ack targetId=${targetId} seq=${seq}`);
}

export async function dispatchInput(targetId, events) {
  const record = streams.get(String(targetId || ""));
  if (!record) throw new Error("No stream active for this tab");
  if (!Array.isArray(events) || !events.length) return { dispatched: 0 };

  const t0 = DIAG ? Date.now() : 0;
  const batch = events.slice(0, STREAM_INPUT_BATCH_MAX);
  for (const evt of batch) {
    const call = record.client.call.bind(record.client);
    const sid = record.sessionId;
    if (evt?.t === "pointer") {
      const type = evt.type === "press" ? "mousePressed"
        : evt.type === "release" ? "mouseReleased" : "mouseMoved";
      await call("Input.dispatchMouseEvent", {
        type,
        x: Number(evt.x) || 0,
        y: Number(evt.y) || 0,
        button: ["left", "right", "middle"].includes(evt.button) ? evt.button : "left",
        clickCount: Number(evt.clickCount) || 1
      }, sid).catch(() => {});
    } else if (evt?.t === "touch") {
      // Real touch: Chrome synthesizes taps, scrolling and momentum from these.
      const type = evt.type === "start" ? "touchStart" : evt.type === "end" ? "touchEnd" : "touchMove";
      await call("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : cdpTouchPoints(evt.points)
      }, sid).catch(() => {});
    } else if (evt?.t === "wheel") {
      // ctrl+wheel is Chrome's native page zoom — the web pane maps pinch to it.
      await call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(evt.x) || 0,
        y: Number(evt.y) || 0,
        deltaX: Number(evt.deltaX) || 0,
        deltaY: Number(evt.deltaY) || 0,
        modifiers: evt.ctrlKey ? 2 : 0
      }, sid).catch(() => {});
    } else if (evt?.t === "text" && typeof evt.text === "string" && evt.text) {
      await call("Input.insertText", { text: evt.text.slice(0, 1000) }, sid).catch(() => {});
    } else if (evt?.t === "key" && KEY_CODES[String(evt.key || "").toLowerCase()]) {
      const code = KEY_CODES[String(evt.key).toLowerCase()];
      const base = { key: evt.key, code, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sid).catch(() => {});
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid).catch(() => {});
    }
  }
  if (DIAG) {
    const ms = Date.now() - t0;
    logger.info(`TEMP DIAGNOSTIC input n=${batch.length} took=${ms}ms`);
  }
  return { dispatched: batch.length };
}

export function activeStreams() {
  return [...streams.keys()];
}
