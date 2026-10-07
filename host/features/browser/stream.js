import {
  KEY_DEFINITIONS,
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
// Host-side raster density — 1.1× buys back most of the 2× sharpness at a
// quarter of the pixels: 2× proved crisp but stuttery (encode+broadcast cost).
const RENDER_SCALE = 1.1;
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
  if (DIAG) logger.info(`TEMP DIAGNOSTIC startStream target=${id} req=${size.width}x${size.height} scale=${size.scale} headless=${process.env.NREMOTE_BROWSER_HEADLESS !== "0"}`);

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
    // Chrome only screencasts the FRONT tab — with several tabs open a stream
    // on a background one stalls after a frame or two. Front the streamed tab
    // so whoever starts streaming owns the compositor.
    await client.call("Page.bringToFront", {}, sessionId).catch(() => {});
    // Resize the browser WINDOW itself to the pane's stage — the compositor
    // surface follows the window, and a stale window size letterboxes/shrinks
    // the stream no matter what the viewport override says.
    try {
      const { windowId } = await client.call("Browser.getWindowForTarget", { targetId: id });
      // Headed: setWindowBounds sizes the OUTER window (tab + address bar eat
      // ~90px) — the content ends up smaller than the requested viewport and
      // Chrome rescales the page to fit = blurry stream + offset inputs.
      // setContentsSize targets the content area in DIP exactly and grows the
      // window to match (headless Chrome lacks the method entirely).
      if (process.env.NREMOTE_BROWSER_HEADLESS === "0") {
        await client.call("Browser.setContentsSize", { windowId, width: size.width, height: size.height });
      } else {
        await client.call("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal", width: size.width, height: size.height }
        });
      }
    } catch (e) {
      // TEMP DIAGNOSTIC: a silent best-effort hide exactly this failure — log it.
      if (DIAG) logger.info(`TEMP DIAGNOSTIC window resize failed: ${e.message}`);
    }
    // Lock the viewport to the requested size — without this Chrome keeps its
    // own (window chrome eats ~90px) and every input coordinate lands offset.
    // dsf MUST match the launch flag (--force-device-scale-factor=2): the
    // override REPLACES it, and 1 here rasters at half the physical pixels —
    // the pane then upscales = the blurry stream on a Retina host.
    // Input stays pixel-correct: coords map through meta.deviceWidth (DIPs).
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: RENDER_SCALE,
      mobile: false
    }, sessionId);
    await client.call("Page.startScreencast", {
      format: "jpeg",
      quality: STREAM_QUALITY,
      // 2× raster + jpeg: the sharpness came from RENDER_SCALE, png only
      // stalled the frame pipeline (multi-MB frames, ~1 frame/10s).
      maxWidth: Math.round(size.width * RENDER_SCALE),
      maxHeight: Math.round(size.height * RENDER_SCALE),
      everyNthFrame: STREAM_EVERY_NTH
    }, sessionId);
  } catch (e) {
    await stopStream(id);
    throw e;
  }

  // Paint the cached frame immediately; a static page emits nothing until it
  // repaints, which otherwise reads as a dead stream right after connect.
  // BUT only when it matches the requested viewport: a cached frame from a
  // smaller viewport (mobile preset, old stage size) would paint BLURRY and
  // linger — the metrics override above forces a fresh repaint anyway.
  const cached = lastFrames.get(id);
  if (cached && Math.round(cached.meta?.deviceWidth || 0) === size.width) {
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
    if (DIAG && record.seq === 1) {
      // TEMP DIAGNOSTIC: first frame vs requested — a mismatch means the
      // headed window chrome (tab/address bar ~90px) is eating the bounds.
      // JPEG pixel size comes from the SOF marker: metadata can LIE (it echoes
      // the override) while the bitmap shows what Chrome really painted.
      let px = "?";
      try {
        const buf = Buffer.from(params.data, "base64");
        for (let i = 2; i < buf.length - 8; i++) {
          if (buf[i] === 0xff && buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xcf && buf[i + 1] !== 0xc4 && buf[i + 1] !== 0xc8) {
            px = `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`;
            break;
          }
        }
      } catch { /* diagnostic only */ }
      logger.info(`TEMP DIAGNOSTIC first frame dev=${m.deviceWidth}x${m.deviceHeight} jpeg=${px} pageScale=${m.pageScaleFactor}`);
    }
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
    } else if (evt?.t === "key") {
      // Proper key/code names + keyDown (not rawKeyDown): Chrome skips the
      // default action (backspace, enter...) when the definition is malformed.
      const def = KEY_DEFINITIONS[String(evt.key || "").toLowerCase()];
      if (def) {
        const base = { ...def, nativeVirtualKeyCode: def.windowsVirtualKeyCode };
        await call("Input.dispatchKeyEvent", { type: "keyDown", ...base }, sid).catch(() => {});
        await call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid).catch(() => {});
      }
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
