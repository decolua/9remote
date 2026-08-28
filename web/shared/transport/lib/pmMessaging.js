import { CHANNELS, CONTROL_RTC_MAX_BYTES, ADAPTER_STATE } from "@/shared/constants/transport";
import { controlBytes } from "./controlRouting";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

// The data path: control sends (with ack + carrier fallback), the pending-send
// buffer, inbound dispatch and binary routing.
// Extracted verbatim from ProtocolManager.

/**
 * Send control event with multi-arg + optional callback (last fn arg = ack).
 * WS adapter uses socket.io native multi-arg/ack; RTC uses {event, args, ackId} envelope.
 */
export function sendControl(pm, event, args) {
  const last = args[args.length - 1];
  const cb = typeof last === "function" ? args.pop() : null;
  let adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) {
    debugLog("transport", `[pm] buffer event=${event} (no adapter ready)`);
    termLog("switch", `buffer "${event}" (no adapter)`);
    pm._buffer.push({ event, args, cb });
    return;
  }
  // Preemptive size-routing: SCTP DC rejects oversize control payloads (> CONTROL_RTC_MAX_BYTES)
  // with a throw/false, corrupting the channel into a zombie state. Route oversize payloads
  // to WS (no SCTP limit) before attempting RTC.
  if (adapter.constructor.id === "rtc" && controlBytes(args) > CONTROL_RTC_MAX_BYTES) {
    const ws = pm._adapters.get("ws");
    if (ws?.ready) adapter = ws;
  }
  debugLog("transport", `[pm] send control event=${event} via=${adapter.constructor.id}`);
  if (adapter.constructor.id === "rtc") {
    let ackId = null;
    if (cb) {
      ackId = `c_${++pm._ackSeq}`;
      pm._pendingAcks.set(ackId, cb);
      // Short timeout — zombie RTC (open but bytes lost) means ack never arrives.
      // On expiry, trigger restart instead of waiting the full 30s.
      pm._scheduleAckTimeout(ackId);
    }
    const ok = adapter.send(CHANNELS.control, { event, args, ackId });
    // RTC DC silently dropped (dead SCTP / oversize slipped through) → fallback WS so
    // the request doesn't hang. Mirrors agent _sendControl fallback.
    if (!ok) {
      const ws = pm._adapters.get("ws");
      if (ws?.ready) {
        if (cb) ws.send(CHANNELS.control, { event, args, cb });
        else ws.send(CHANNELS.control, { event, args });
      }
    }
  } else {
    // WS path — pass through to socket.io native (multi-arg + ack supported)
    adapter.send(CHANNELS.control, { event, args, cb });
  }
}

export function flushBuffer(pm) {
  if (!pm._buffer.length) return;
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) return;
  debugLog("transport", `[pm] flush ${pm._buffer.length} buffered via=${adapter.constructor.id}`);
  while (pm._buffer.length) {
    const { event, args, cb } = pm._buffer.shift();
    const argsWithCb = cb ? [...args, cb] : args;
    pm._sendControl(event, argsWithCb);
  }
}

/**
 * Dispatch incoming message. RTC payloads carry {args} array; WS payloads carry {data}
 * (legacy single-arg from raw socket.io onAny).
 */
export function dispatch(pm, event, payload, source) {
  // Resolve ack reply — may arrive via RTC or WS (agent falls back to WS when RTC dies)
  if (event === "__ack") {
    const { ackId, args } = payload || {};
    const cb = pm._pendingAcks.get(ackId);
    if (cb) {
      pm._pendingAcks.delete(ackId);
      const t = pm._ackTimers.get(ackId);
      if (t) { clearTimeout(t); pm._ackTimers.delete(ackId); }
      cb(...(args || []));
    }
    return;
  }
  // Host approved (from either carrier) → recovery paths may renegotiate again.
  // If ICE timed out while waiting (host took >30s), the peer is gone — the
  // agent's buffered answer can't revive it, so renegotiate a fresh offer.
  if (event === "device:approved") {
    pm._awaitingApproval = false;
    const rtc = pm._adapters.get("rtc");
    if (pm._canSignal() && (!rtc || rtc.state === ADAPTER_STATE.closed)) {
      pm._restartRtc("device-approved");
    }
  }
  // Agent test-toggle re-enabled RTC → clear the stop-retry flag and renegotiate.
  if (event === "rtc:enabled") {
    if (pm._rtcTestDisabled) {
      pm._rtcTestDisabled = false;
      termLog("switch", "rtc:enabled by agent → clear flag + restart RTC");
      pm._restartRtc("rtc-enabled");
    }
    return;
  }
  // RTC control envelope carries {event, args}; binary path (tiles-data) keeps raw data
  const args = source === "rtc" && Array.isArray(payload?.args)
    ? payload.args
    : [payload];
  // 1) PM bus listeners
  const set = pm._listeners.get(event);
  if (set) for (const h of set) h(...args);
  // 2) Forward to raw socket listeners ONLY if not from WS (WS source: socket.io already
  // invoked native listeners; forwarding would double-fire).
  if (source === "ws") return;
  const sock = pm.socketRef.current;
  if (!sock) return;
  const fns = sock.listeners?.(event);
  if (fns?.length) for (const fn of fns) fn(...args);
}

/**
 * Incoming binary frame from an adapter's "binary" event (RTC DC "file").
 * Route to socket.io-style "file-bin" listeners so WS and RTC paths share one
 * handler (WS delivers "file-bin" natively via socket.io onAny).
 */
export function onBinary(pm, msg) {
  if (!msg || msg.channel !== "file") return;
  const sock = pm.socketRef.current;
  if (!sock) return;
  const fns = sock.listeners?.("file-bin");
  if (fns?.length) for (const fn of fns) fn(msg.buffer);
}

// Short ack timeout — if ack doesn't arrive, RTC is likely zombie (open but bytes lost).
export function scheduleAckTimeout(pm, ackId) {
  const timer = setTimeout(() => {
    pm._ackTimers.delete(ackId);
    debugLog("transport", `[pm] ack timeout ackId=${ackId} → suspect zombie RTC`);
    pm._scheduleRtcRestart("ack-timeout");
  }, pm._ackTimeoutMs);
  pm._ackTimers.set(ackId, timer);
}
