import { CHANNELS, CONTROL_RTC_MAX_BYTES, ADAPTER_STATE } from "@/shared/constants/transport";
import { controlBytes } from "./controlRouting";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { probeRtcLiveness } from "./pmWatchers";

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
  if (event === "getSessions" || event === "getWorkspaces") termLog("diag", `send ${event} via=${adapter.constructor.id}`); // TEMP DIAGNOSTIC
  if (event === "getSessions" || event === "getWorkspaces") termLog("diag", `send ${event} via=${adapter.constructor.id}`); // TEMP DIAGNOSTIC
  if (adapter.constructor.id === "rtc") {
    let ackId = null;
    if (cb) {
      ackId = `c_${++pm._ackSeq}`;
      pm._pendingAcks.set(ackId, cb);
      // Short timeout — zombie RTC (open but bytes lost) means ack never arrives.
      // On expiry the timer retries a safe read over WS, else escalates a restart.
      pm._scheduleAckTimeout(ackId, { event, args });
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
  // Agent capability announcement. It rides whichever carrier is up first — after
  // a cold start that is usually WS, since RTC is still gathering ICE — so it is
  // read here, not off the RTC channel, and handed to the adapter it configures.
  if (event === "srvCaps") {
    const caps = source === "rtc" ? payload?.args?.[0] : payload;
    debugLog("transport", `[pm] srvCaps from agent via ${source}: ${JSON.stringify(caps)}`);
    // Remembered on the PM, not only handed to the adapter: RTC may not exist yet
    // (its start is deferred until signaling is ready) and it is torn down and
    // rebuilt on every renegotiation — a fresh instance re-reads this.
    pm._srvCaps = caps || {};
    pm._adapters.get("rtc")?.setPeerCaps?.(pm._srvCaps);
  }
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
    termLog("diag", `device:approved reached transport via=${source}`); // TEMP DIAGNOSTIC
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
  // 1) PM-internal listeners
  const set = pm._listeners.get(event);
  if (set) for (const h of set) h(...args);
  // 2) The app's listeners, which all live on the one bus — the carrier that
  // delivered this is not its business. (Previously the WS path returned here
  // because socket.io had already invoked the handlers itself; now nothing is
  // registered on the bus, so every carrier ends the same way.)
  pm._bus?.dispatch(event, args);
}

/**
 * Incoming binary frame from an adapter's "binary" event (RTC DC "file").
 * Route to socket.io-style "file-bin" listeners so WS and RTC paths share one
 * handler (WS delivers "file-bin" natively via socket.io onAny).
 */
export function onBinary(pm, msg) {
  if (!msg || msg.channel !== "file") return;
  // Same door as every other event: WS delivers "file-bin" through the normal
  // dispatch, RTC arrives here as a raw frame — both end at the one registry.
  pm._bus?.dispatch("file-bin", [msg.buffer]);
}

// Requests that may be re-sent as-is after an ack timeout. Reads only: a retried
// create/rename would run twice on the agent. This is the list-loading pair that
// a first-connect RTC blip strands (fresh browser → RTC-first → young trickling
// DC eats an ack → restart ladder refuses to act while state=open → stuck UI).
const ACK_RETRY_SAFE = new Set(["getSessions", "getWorkspaces"]);

// Short ack timeout — if ack doesn't arrive, RTC is likely zombie (open but bytes lost).
// Safe reads retry once over WS immediately (the UI recovers in ~5s, no restart);
// anything else escalates the restart ladder.
export function scheduleAckTimeout(pm, ackId, ctx) {
  const timer = setTimeout(() => {
    pm._ackTimers.delete(ackId);
    debugLog("transport", `[pm] ack timeout ackId=${ackId} → suspect zombie RTC`);
    const cb = pm._pendingAcks.get(ackId);
    // A state=open peer that just ate a message is the prime zombie suspect —
    // probe it (ICE keepalive counter) and force-restart if dead. The restart
    // ladder alone refuses to act while state=open, which is how a first-connect
    // zombie survived forever and every read kept dying on it.
    const rtc = pm._adapters.get("rtc");
    if (rtc?.state === ADAPTER_STATE.open) probeRtcLiveness(pm, "ack-timeout");
    const ws = pm._adapters.get("ws");
    if (cb && ctx && ws?.ready && ACK_RETRY_SAFE.has(ctx.event)) {
      pm._pendingAcks.delete(ackId);
      termLog("switch", `ack-timeout ${ctx.event} → retry via ws (rtc zombie?)`);
      ws.send(CHANNELS.control, { event: ctx.event, args: ctx.args, cb });
      return;
    }
    pm._scheduleRtcRestart("ack-timeout");
  }, pm._ackTimeoutMs);
  pm._ackTimers.set(ackId, timer);
}
