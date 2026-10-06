import {
  KEY_CODES,
  STREAM_ACK_TIMEOUT_MS,
  STREAM_EVERY_NTH,
  STREAM_INPUT_BATCH_MAX,
  STREAM_MAX_EDGE,
  STREAM_MIN_INTERVAL_MS,
  STREAM_QUALITY
} from "./constants.js";

const streams = new Map();

export function clampViewport(raw = {}) {
  const num = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, STREAM_MAX_EDGE) : fallback;
  };
  return { width: num(raw.width, 720), height: num(raw.height, 1280) };
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
    seq: 0, lastSentAt: 0, pendingSeq: 0, ackTimer: null, stopped: false
  };

  const onFrame = (params, evSessionId) => {
    if (record.stopped || evSessionId !== record.sessionId) return;
    handleFrame(record, id, params);
  };

  record.offEvent = client.on("Page.screencastFrame", onFrame);
  streams.set(id, record);

  try {
    await client.call("Page.startScreencast", {
      format: "jpeg",
      quality: STREAM_QUALITY,
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: STREAM_EVERY_NTH
    }, sessionId);
  } catch (e) {
    await stopStream(id);
    throw e;
  }

  return { targetId: id, ...size };
}

export async function stopStream(targetId) {
  const id = String(targetId || "");
  const record = streams.get(id);
  if (!record) return { stopped: id };
  record.stopped = true;
  streams.delete(id);
  if (record.ackTimer) clearTimeout(record.ackTimer);
  record.offEvent?.();
  await record.client.call("Page.stopScreencast", {}, record.sessionId).catch(() => {});
  await record.detach?.();
  return { stopped: id };
}

function cdpAck(record) {
  if (record.pendingSeq) {
    record.pendingSeq = 0;
    if (record.ackTimer) clearTimeout(record.ackTimer);
    record.client.call("Page.screencastFrameAck", { sessionId: record.sessionId }, record.sessionId)
      .catch(() => {});
  }
}

function handleFrame(record, targetId, params) {
  const now = Date.now();
  if (!frameAdmitted(record.lastSentAt, now)) {
    cdpAck(record);
    return;
  }
  record.lastSentAt = now;
  record.seq += 1;
  record.pendingSeq = record.seq;
  if (record.ackTimer) clearTimeout(record.ackTimer);
  record.ackTimer = setTimeout(() => cdpAck(record), STREAM_ACK_TIMEOUT_MS);

  const m = params.metadata || {};
  record.emit({
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
  });
}

export function ackFrame(targetId, seq) {
  const record = streams.get(String(targetId || ""));
  if (record && record.pendingSeq === Number(seq)) cdpAck(record);
}

export async function dispatchInput(targetId, events) {
  const record = streams.get(String(targetId || ""));
  if (!record) throw new Error("No stream active for this tab");
  if (!Array.isArray(events) || !events.length) return { dispatched: 0 };

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
        clickCount: 1
      }, sid).catch(() => {});
    } else if (evt?.t === "wheel") {
      await call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(evt.x) || 0,
        y: Number(evt.y) || 0,
        deltaX: Number(evt.deltaX) || 0,
        deltaY: Number(evt.deltaY) || 0
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
  return { dispatched: batch.length };
}

export function activeStreams() {
  return [...streams.keys()];
}
