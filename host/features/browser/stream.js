import {
  KEY_DEFINITIONS,
  BROWSER_TILE_SIZE,
  STREAM_ACK_DEAD_MS,
  STREAM_ACK_WINDOW,
  STREAM_EVERY_NTH,
  STREAM_INPUT_BATCH_MAX,
  STREAM_MAX_EDGE,
  STREAM_MIN_INTERVAL_MS,
  STREAM_QUALITY,
  STREAM_TILE_FULL_RATIO
} from "./constants.js";
import { BROWSER_FLAG_FULL, BROWSER_FLAG_TILES } from "./browserFrame.js";
import crypto from "node:crypto";
import { buildTilesBatch, decodeJpegRaw, diffTiles, makeGrid } from "./browserTileGrid.js";
import { encodeTilesBatch } from "../remote/handlers/ScreenHandler.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("browserStream");

const streams = new Map();
// Host-side raster density — 2× proved crisp but stuttery (encode+broadcast
// cost); 1.2× rides the binary lane + ack-window headroom from the tile work.
export const RENDER_SCALE = 1.2;
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
  // Two panes (two workspaces) may stream the SAME tab. A second start used to
  // kill the first pane's stream — with client retries that became an endless
  // steal-war of alternating images. Share one record per tab instead.
  const existing = streams.get(id);
  if (existing && !existing.stopped) {
    existing.refs += 1;
    return { targetId: id, ...existing.size, quality: existing.quality };
  }

  const attached = await client.call("Target.attachToTarget", { targetId: id, flatten: true });
  const sessionId = attached.sessionId;
  const detach = () => client.call("Target.detachFromTarget", { sessionId }).catch(() => {});

  const size = clampViewport(viewport);
  // Client-driven quality (adaptive): clamped, defaulting to the constant.
  const quality = Math.min(95, Math.max(50, Math.round(Number(viewport?.quality) || STREAM_QUALITY)));
  const record = {
    client, sessionId, detach, emit, size, quality,
    seq: 0, lastSentAt: 0, stopped: false, refs: 1,
    inFlight: new Set(), pendingFrame: null,
    tileHashes: null, gridW: 0, gridH: 0, lastJpegHash: null
  };

  const onFrame = (params, evSessionId) => {
    if (record.stopped || evSessionId !== record.sessionId) return;
    void handleFrame(record, id, params);
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
    } catch { /* best-effort; the override below still pins the viewport */ }
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
      quality,
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
  if (cached) {
    // Paint instantly on rejoin — even a stale-size frame reads far better
    // than a black stage while the resize settles. The cached seq keeps the
    // sequence monotonic: new frames continue from it. Tile hashes reset: the
    // next CDP frame re-diffs against a blank client → full batch.
    record.seq = cached.seq;
    record.inFlight.add(cached.seq);
    record.lastSentAt = Date.now();
    record.tileHashes = null;
    record.gridW = 0;
    record.gridH = 0;
    record.emit(cached);
  }
  // Nudge a repaint so the first LIVE frame at the requested size arrives
  // without waiting for one.
  client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 }, sessionId)
    .catch(() => {});

  return { targetId: id, ...size, quality };

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

function cdpAck(record, frameSessionId) {
  // UNCONDITIONAL, like the POC: Chrome stalls its screencast queue the moment
  // any received frame goes unacked — admission pacing below only decides what
  // we forward, never whether Chrome may keep producing.
  // The ack's param is the FRAME's own sessionId (a counter), NOT the attach
  // session — passing the attach session makes Chrome drop every ack and the
  // screencast dies after the first couple of frames.
  record.client.call("Page.screencastFrameAck", { sessionId: frameSessionId }, record.sessionId)
    .catch(() => {});
}

// Build + send one frame. Reserves the ack-window slot SYNCHRONOUSLY (before
// the async decode) so two in-flight CDP frames can't both see free room.
// Chrome's jpeg goes through the tile grid: identical pixels → nothing on the
// wire, small edits → one tile, undecodable input → full-jpeg fallback.
async function sendFrame(record, targetId, params, now) {
  record.seq += 1;
  const seq = record.seq;
  record.inFlight.add(seq);
  record.lastSentAt = now;
  const m = params.metadata || {};
  const meta = {
    deviceWidth: m.deviceWidth,
    deviceHeight: m.deviceHeight,
    scrollX: m.scrollOffsetX,
    scrollY: m.scrollOffsetY,
    scale: m.pageScaleFactor,
    offsetTop: m.offsetTop
  };
  const jpeg = Buffer.from(params.data, "base64");
  // Fast path: Chrome re-emitted the exact same jpeg — identical bytes are
  // identical pixels, skip the decode entirely.
  const jpegHash = crypto.hash("md5", jpeg);
  if (record.tileHashes && record.lastJpegHash === jpegHash) {
    record.inFlight.delete(seq);
    return false;
  }
  record.lastJpegHash = jpegHash;
  let image = jpeg;
  let flags = BROWSER_FLAG_FULL;
  try {
    const raw = await decodeJpegRaw(jpeg);
    if (record.gridW !== raw.width || record.gridH !== raw.height) {
      record.tileHashes = null;
      record.gridW = raw.width;
      record.gridH = raw.height;
    }
    const grid = makeGrid(raw.width, raw.height, BROWSER_TILE_SIZE);
    const { changed, hashes } = diffTiles(record.tileHashes, raw, grid);
    record.tileHashes = hashes;
    meta.frameW = raw.width;
    meta.frameH = raw.height;
    if (changed.length === 0) {
      // Nothing changed — release the slot, keep the pacing timestamp.
      record.inFlight.delete(seq);
      return false;
    }
    // Hybrid: a wholesale change (scroll, navigation, first frame) re-encodes
    // every tile for no byte savings — forward Chrome's own jpeg instead.
    // The tile hashes above still advance, so the next partial diff is exact.
    if (changed.length < Math.ceil(grid.totalTiles * STREAM_TILE_FULL_RATIO)) {
      const tiles = await buildTilesBatch(raw, grid, changed, hashes, record.quality);
      image = encodeTilesBatch(tiles, now);
      flags = BROWSER_FLAG_TILES;
    }
  } catch (e) {
    logger.warn(`tile pipeline failed, falling back to full jpeg: ${e.message}`);
  }
  const payload = { targetId, seq, image, flags, meta };
  // Replay cache holds FULL frames only — a partial batch is useless to a
  // pane with a blank canvas.
  if (flags === BROWSER_FLAG_FULL || tileCount(payload) === gridTileCount(record)) {
    if (lastFrames.size >= LAST_FRAMES_MAX) lastFrames.delete(lastFrames.keys().next().value);
    lastFrames.set(targetId, payload);
  }
  if (record.emit(payload) === false) {
    record.inFlight.delete(seq);
    return false;
  }
  return true;
}

function tileCount(payload) {
  if (payload.flags !== BROWSER_FLAG_TILES) return -1;
  return new DataView(payload.image.buffer, payload.image.byteOffset, payload.image.byteLength).getUint32(0, true);
}

function gridTileCount(record) {
  if (!record.gridW || !record.gridH) return -1;
  return Math.ceil(record.gridW / BROWSER_TILE_SIZE) * Math.ceil(record.gridH / BROWSER_TILE_SIZE);
}

export async function handleFrame(record, targetId, params, now = Date.now()) {
  // Ack Chrome FIRST — a throwing/slow emit must never delay the CDP ack or
  // the screencast queue stalls after a frame or two.
  cdpAck(record, params.sessionId);
  if (record.stopped) return;
  // Ack window release for a peer that never acks (old client, lost control
  // lane): freezing forever is worse than overrunning a slow link.
  if (record.inFlight.size && now - record.lastSentAt > STREAM_ACK_DEAD_MS) record.inFlight.clear();
  if (!frameAdmitted(record.lastSentAt, now)) return;
  if (record.inFlight.size >= STREAM_ACK_WINDOW) {
    // Window full: hold the newest (coalesced — intermediate frames age out),
    // the next client ack flushes it.
    record.pendingFrame = { targetId, params };
    return;
  }
  await sendFrame(record, targetId, params, now);
}

// Ordered lane: acking seq covers every older frame too.
export async function releaseAck(record, seq) {
  for (const s of record.inFlight) {
    if (s <= seq) record.inFlight.delete(s);
  }
  if (record.pendingFrame && record.inFlight.size < STREAM_ACK_WINDOW) {
    const held = record.pendingFrame;
    record.pendingFrame = null;
    await sendFrame(record, held.targetId, held.params, Date.now());
  }
}

export function ackFrame(targetId, seq) {
  const record = streams.get(String(targetId || ""));
  if (record) releaseAck(record, seq);
}

// One in-flight batch per tab: socket handlers for separate browser:input
// messages run concurrently, and concurrent CDP dispatches land in Chrome out
// of order — a scroll suddenly moving backwards mid-gesture.
const inputQueues = new Map();

export async function dispatchInput(targetId, events) {
  const record = streams.get(String(targetId || ""));
  if (!record) throw new Error("No stream active for this tab");
  if (!Array.isArray(events) || !events.length) return { dispatched: 0 };

  const batch = events.slice(0, STREAM_INPUT_BATCH_MAX);
  const id = String(targetId || "");
  const prev = inputQueues.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await dispatchBatch(record, batch);
    return { dispatched: batch.length };
  });
  inputQueues.set(id, run.catch(() => {}));
  return run;
}

async function dispatchBatch(record, batch) {
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
}

export function activeStreams() {
  return [...streams.keys()];
}

// A live stream means someone is watching this browser — never idle-close it.
export function hasActiveStreamFor(client) {
  for (const record of streams.values()) {
    if (record.client === client) return true;
  }
  return false;
}
