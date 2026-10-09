import {
  KEY_DEFINITIONS,
  BROWSER_MOBILE_EMULATION,
  BROWSER_TILE_SIZE,
  STREAM_ACK_DEAD_MS,
  STREAM_ACK_WINDOW,
  STREAM_EVERY_NTH,
  STREAM_REFUSED_BACKOFF_MS,
  STREAM_INPUT_BATCH_MAX,
  STREAM_MAX_EDGE,
  STREAM_MIN_INTERVAL_MS,
  STREAM_QUALITY
} from "./constants.js";
import { cachedUserAgentIdentity, identityOverride, mobileOverride, readUserAgentIdentity } from "./antiDetection.js";
import { BROWSER_FLAG_TILES } from "./browserFrame.js";
import crypto from "node:crypto";
import { buildTilesBatch, decodeJpegRaw, diffTiles, makeGrid } from "./browserTileGrid.js";
import { encodeTilesBatch } from "../remote/handlers/ScreenHandler.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("browserStream");

const streams = new Map();
// Host-side raster density — 2× proved crisp but stuttery (encode+broadcast
// cost); 1.2× rides the binary lane + ack-window headroom from the tile work.
export const RENDER_SCALE = 1.2;

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
  return { width: num(raw.width, 720), height: num(raw.height, 1280), scale, mobile: !!raw.mobile };
}

// Chrome fits the screencast into a maxWidth×maxHeight box and rounds DOWN, so
// a fractional raster (1284×1.25=1605, 397×1.25=496.25) flips the frame between
// 1605 and 1604 wide — every flip reshapes the tile grid and wipes the canvas.
// Snap the viewport so viewport×scale is an exact integer and use that as the box.
// Desktop only: a mobile preset keeps its exact CSS size (dsf comes from the profile).
export function snapRaster(size, scale) {
  if (size.mobile) {
    return { size, box: { width: Math.ceil(size.width * scale), height: Math.ceil(size.height * scale) } };
  }
  const step = scale === 1 ? 1 : 4; // 0.25 steps: ×4 makes the product integral
  const width = Math.max(step, Math.floor(size.width / step) * step);
  const height = Math.max(step, Math.floor(size.height / step) * step);
  return { size: { ...size, width, height }, box: { width: width * scale, height: height * scale } };
}

export function frameAdmitted(lastSentAt, now, minIntervalMs = STREAM_MIN_INTERVAL_MS) {
  return now - lastSentAt >= minIntervalMs;
}

// Viewport + identity emulation, ONE door shared by setViewport and stream
// starts: metrics, UA override and touch capability must move together — a
// mobile viewport under a desktop UA (or a stale mobile UA after switching
// back) is exactly the fingerprint mismatch sites block on. Width/height null
// = clear the metrics override (back to the window's own size).
export async function applyEmulation(client, sessionId, { width = null, height = null, mobile = false, scale = 0 } = {}) {
  if (width && height) {
    await client.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      // Client-driven density (local links send the viewer's real DPR); 0/1 = the tuned default.
      deviceScaleFactor: mobile ? BROWSER_MOBILE_EMULATION.deviceScaleFactor : (scale > 1 ? scale : RENDER_SCALE),
      mobile,
      ...(mobile ? { screenWidth: width, screenHeight: height, screenOrientation: { type: "portraitPrimary", angle: 0 } } : {})
    }, sessionId);
  } else {
    await client.call("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  }
  const identity = cachedUserAgentIdentity(client) || (await readUserAgentIdentity(client, sessionId));
  const params = mobile ? mobileOverride(identity) : identityOverride(identity);
  // Identity is essential — let a real failure propagate (callers log it);
  // touch capability is best-effort on older builds.
  if (params) await client.call("Emulation.setUserAgentOverride", params, sessionId);
  await client.call("Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    ...(mobile ? { maxTouchPoints: BROWSER_MOBILE_EMULATION.maxTouchPoints } : {})
  }, sessionId).catch(() => {});
}

// Serialize stream starts per tab: two concurrent startStreams both pass the
// existing-record check (it runs before the attach await resolves) and create
// TWO records — the loser's onFrame listener is never removed, so two
// screencast pipelines emit interleaved seqs and stale tiles paint over fresh
// ones. A second start now waits for the first, then joins its record.
const startingStreams = new Map(); // targetId -> Promise

export function startStream(client, targetId, viewport, emit) {
  const id = String(targetId || "");
  if (!id) throw new Error("Missing field: targetId");
  const prev = startingStreams.get(id);
  const run = (prev ? prev.catch(() => {}) : Promise.resolve())
    .then(() => startStreamInternal(client, id, viewport, emit));
  startingStreams.set(id, run);
  run.finally(() => { if (startingStreams.get(id) === run) startingStreams.delete(id); })
    .catch(() => {});
  return run;
}

// Two panes (two workspaces) may stream the SAME tab. A second start used to
// kill the first pane's stream — with client retries that became an endless
// steal-war of alternating images. Share one record per tab instead.
function joinStream(id) {
  const existing = streams.get(id);
  if (!existing || existing.stopped) return null;
  // The joining pane's canvas is BLANK, but the record's tile hashes describe
  // the old pane's canvas — the next diff would emit a partial batch the
  // newcomer paints as holes. Drop the hashes: the next CDP frame re-diffs
  // against nothing and the hybrid rule forwards a FULL frame to every pane.
  existing.tileHashes = null;
  existing.dimsKey = null; // the joiner never saw the size
  existing.tileGen = (existing.tileGen || 0) + 1;
  // No cached-frame replay here (emit broadcasts; the old pane must not
  // flash back to a stale frame) — nudge a repaint like fresh records do so
  // a static page still ships that full frame promptly.
  nudgeRepaint(existing);
  return { targetId: id, ...existing.size, scale: existing.scale, quality: existing.quality };
}

async function startStreamInternal(client, id, viewport, emit) {
  const joined = joinStream(id);
  if (joined) return joined;

  const attached = await client.call("Target.attachToTarget", { targetId: id, flatten: true });
  const sessionId = attached.sessionId;
  const detach = () => client.call("Target.detachFromTarget", { sessionId }).catch(() => {});

  const requested = clampViewport(viewport);
  // Raster density: tuned to 1.25x max (2x quadruples tile count and saturates transport),
  // in 0.25 steps so snapRaster can keep the raster integral.
  const scale = Math.min(1.25, Math.max(0.75, Math.round((Number(requested.scale) || RENDER_SCALE) * 4) / 4));
  const { size, box } = snapRaster(requested, scale);
  // Quality: clamped to 85 max to keep tile batches lightweight and fast.
  const quality = Math.min(85, Math.max(50, Math.round(Number(viewport?.quality) || STREAM_QUALITY)));
  const record = {
    client, sessionId, detach, emit, size, scale, quality,
    seq: 0, lastSentAt: 0, stopped: false,
    inFlight: new Set(), pendingFrame: null,
    tileHashes: null, gridW: 0, gridH: 0, lastJpegHash: null, tileGen: 0,
    // tileIndex -> seq that last delivered it — lets a verify request tell
    // "client never got this tile" (sent AFTER its last full frame) apart
    // from "client has it via the full frame" (no hash claim needed).
    tileSentSeq: new Map(), verifyBusy: false
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
    // Lock the viewport + identity emulation to the requested size — without
    // this Chrome keeps its own (window chrome eats ~90px) and every input
    // coordinate lands offset. Input stays pixel-correct: coords map through
    // meta.deviceWidth (DIPs).
    await applyEmulation(client, sessionId, { width: size.width, height: size.height, mobile: !!size.mobile, scale });
    await client.call("Page.startScreencast", {
      format: "jpeg",
      quality,
      // 2× raster + jpeg: the sharpness came from the raster scale, png only
      // stalled the frame pipeline (multi-MB frames, ~1 frame/10s).
      maxWidth: box.width,
      maxHeight: box.height,
      everyNthFrame: STREAM_EVERY_NTH
    }, sessionId);
  } catch (e) {
    await stopStream(id);
    throw e;
  }

  // Nudge a repaint so the first LIVE frame at the requested size arrives
  // without waiting for one.
  nudgeRepaint(record);
  // Guarantee CURRENT pixels on a quiet page: a static page emits no
  // screencast damage and the cached full may predate many tile frames, so
  // one forced capture seeds the stream and refreshes the replay cache.
  client.call("Page.captureScreenshot", { format: "jpeg", quality }, sessionId)
    .then((shot) => {
      if (record.stopped || !shot?.data) return;
      return sendFrame(record, id, {
        data: shot.data,
        metadata: { deviceWidth: size.width, deviceHeight: size.height, scrollOffsetX: 0, scrollOffsetY: 0 },
        sessionId: 0
      }, Date.now());
    })
    .catch(() => {});

  return { targetId: id, ...size, scale, quality };

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
// Remote-desktop delivery contract: tileHashes is the DELIVERED baseline —
// only tiles the wire accepted advance it (TileManager.commitHashes model);
// refused tiles re-diff next frame. Partial batches travel as multiple
// self-contained under-cap messages, never one chunked blob, so a slow link
// can never strand half a frame.
async function sendFrame(record, targetId, params, now) {
  record.seq += 1;
  const seq = record.seq;
  record.inFlight.add(seq);
  record.inFlightTs ??= new Map();
  record.inFlightTs.set(now, seq);
  record.lastSentAt = now;
  // Serialize the async pipeline per record: CDP frames arrive fire-and-forget
  // and two concurrent sendFrames interleave their wire writes at every await,
  // emitting seq N+1 before N — the client drops out-of-order frames, so those
  // tiles would be committed-but-never-painted holes.
  const prevTail = record.sendTail || Promise.resolve();
  let release;
  record.sendTail = new Promise((r) => (release = r));
  await prevTail.catch(() => {});
  try {
    if (record.stopped) {
      record.inFlight.delete(seq);
      return false;
    }
    return await sendFrameLocked(record, targetId, params, now, seq);
  } finally {
    release();
  }
}

async function sendFrameLocked(record, targetId, params, now, seq) {
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
  // Fast path: this exact jpeg was already DELIVERED — identical bytes are
  // identical pixels, skip the decode entirely.
  const jpegHash = crypto.hash("md5", jpeg);
  if (record.tileHashes && record.lastJpegHash === jpegHash) {
    dropInFlight(record, seq, now);
    return false;
  }
  // Stamp the hash generation before the async decode: a pane joining mid-
  // decode nulls tileHashes and bumps tileGen — storing this frame's hashes
  // over that reset would bring partial batches right back.
  const gen = record.tileGen || 0;
  let raw;
  try {
    raw = await decodeJpegRaw(jpeg);
  } catch (e) {
    // The wire only carries tiles: drop the frame, free its slot, and let the
    // client's hash verify repair from a fresh capture.
    logger.warn(`sendFrame undecodable jpeg tid=${targetId.slice(-6)} seq=${seq}: ${e.message}`);
    dropInFlight(record, seq, now);
    return false;
  }
  if (record.gridW !== raw.width || record.gridH !== raw.height) {
    record.tileHashes = null;
    record.gridW = raw.width;
    record.gridH = raw.height;
  }
  const grid = makeGrid(raw.width, raw.height, BROWSER_TILE_SIZE);
  const diffed = diffTiles(record.tileHashes, raw, grid);
  const hashes = diffed.hashes;
  // Verify-repair reads pixels AND hashes from this very decode — a fresh
  // captureScreenshot is a different raster and never hashes the same.
  record.lastRaw = { raw, grid, hashes };
  meta.frameW = raw.width;
  meta.frameH = raw.height;
  if (diffed.changed.length === 0) {
    // Delivered baseline already matches — nothing to send.
    dropInFlight(record, seq, now);
    if ((record.tileGen || 0) === gen) record.lastJpegHash = jpegHash;
    return false;
  }
  // Remote desktop pipeline: 100% tiles, wire-chunked under 48KB, worker-decoded.
  const tiles = await buildTilesBatch(raw, grid, diffed.changed, hashes, record.quality);
  const payload = { targetId, seq, image: encodeTilesBatch(tiles, now), flags: BROWSER_FLAG_TILES, meta, tiles };
  const dims = dimsIfChanged(record, targetId, raw, grid, meta);
  if (dims) payload.dims = dims;
  if (record.emit(payload, now) === false) {
    record.lastSentAt = now + STREAM_REFUSED_BACKOFF_MS;
    return false;
  }
  if (dims) record.dimsKey = dims.key;
  commitDelivered(record, tiles, hashes, gen);
  record.lastJpegHash = jpegHash;
  return true;
}

// A frame that sent nothing must free its window slot AND its ts index, or
// inFlightTs grows forever on a mostly-static page.
function dropInFlight(record, seq, ts) {
  record.inFlight.delete(seq);
  record.inFlightTs?.delete(ts);
}

// Tile batches carry no frame size (remote's wire format is shared), so the
// pane learns it from a small side message: the REAL raster size (canvas) and
// the page's CSS viewport (input mapping). Sent only when it changes.
function dimsIfChanged(record, targetId, raw, grid, meta) {
  const key = `${raw.width}x${raw.height}|${meta.deviceWidth}x${meta.deviceHeight}`;
  if (record.dimsKey === key) return null;
  return {
    key, targetId,
    frameW: raw.width, frameH: raw.height,
    deviceWidth: meta.deviceWidth, deviceHeight: meta.deviceHeight,
    tileCount: grid.totalTiles
  };
}

// Advance the delivered baseline for exactly the tiles the wire took —
// remote's TileManager.commitHashes contract.
function commitDelivered(record, tiles, hashes, gen) {
  if (!tiles.length || (record.tileGen || 0) !== gen) return;
  const committed = record.tileHashes ? new Map(record.tileHashes) : new Map();
  for (const t of tiles) {
    committed.set(t.tileIndex, hashes.get(t.tileIndex) >>> 0);
  }
  record.tileHashes = committed;
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

// Ordered lane: acking seq (or timestamp from useTiles) covers every older frame too.
export async function releaseAck(record, ackVal) {
  if (typeof ackVal === "number" && ackVal > 1_000_000_000_000) {
    if (record.inFlightTs) {
      for (const [ts, s] of record.inFlightTs) {
        if (ts <= ackVal) {
          record.inFlight.delete(s);
          record.inFlightTs.delete(ts);
        }
      }
    }
  } else if (typeof ackVal === "number") {
    for (const s of record.inFlight) {
      if (s <= ackVal) record.inFlight.delete(s);
    }
  } else {
    const oldest = record.inFlight.values().next().value;
    if (oldest != null) record.inFlight.delete(oldest);
  }
  if (record.pendingFrame && record.inFlight.size < STREAM_ACK_WINDOW) {
    const held = record.pendingFrame;
    record.pendingFrame = null;
    await sendFrame(record, held.targetId, held.params, Date.now());
  }
}

// Force a repaint on a quiet page — Chrome only screencasts damage.
function nudgeRepaint(record) {
  record.client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 }, record.sessionId)
    .catch(() => {});
}

// Client-driven verify-repair — Remote Desktop's compareClientTileHashes contract:
// the client periodically sends the hashes of the tiles it painted; the host
// answers with exactly the tiles that differ. The reference is the latest
// decoded stream frame (same raster the client's hashes came from), so a
// healthy client never mismatches and no screenshot is taken.
export async function compareClientTileHashes(targetId, clientTileHashes) {
  const id = String(targetId || "");
  const record = streams.get(id);
  if (!record || record.stopped) return false;
  return compareRecordTileHashes(record, id, clientTileHashes);
}

export async function compareRecordTileHashes(record, id, clientTileHashes) {
  if (record.isComparing) return false;
  const last = record.lastRaw;
  if (!last) return false; // no decoded frame yet — the client's next verify retries
  const fresh = !clientTileHashes?.length;
  // A frame still on the wire is not a lost tile, just a stale claim.
  if (!fresh && record.inFlight.size && Date.now() - record.lastSentAt < STREAM_ACK_DEAD_MS) return false;
  record.isComparing = true;
  try {
    const { raw, grid, hashes } = last;
    const gen = record.tileGen || 0;
    const changedIndices = [];
    for (let i = 0; i < grid.totalTiles; i++) {
      if (fresh || clientTileHashes[i] !== hashes.get(i)) changedIndices.push(i);
    }
    if (!changedIndices.length) return false;

    const tiles = await buildTilesBatch(raw, grid, changedIndices, hashes, record.quality);
    if (record.stopped) return false;
    const now = Date.now();
    const meta = { frameW: raw.width, frameH: raw.height, deviceWidth: record.size.width, deviceHeight: record.size.height };
    record.seq += 1;
    const payload = { targetId: id, seq: record.seq, image: encodeTilesBatch(tiles, now), flags: BROWSER_FLAG_TILES, meta, tiles };
    // A client repairing with empty hashes may be a fresh pane: always re-announce the size.
    if (fresh) record.dimsKey = null;
    const dims = dimsIfChanged(record, id, raw, grid, meta);
    if (dims) payload.dims = dims;
    if (record.emit(payload, now) === false) return false;
    if (dims) record.dimsKey = dims.key;
    commitDelivered(record, tiles, hashes, gen);
    return true;
  } catch (e) {
    logger.warn(`compareClientTileHashes failed: ${e.message}`);
    return false;
  } finally {
    record.isComparing = false;
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
