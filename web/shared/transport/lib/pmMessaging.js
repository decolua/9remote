import { CHANNELS, ADAPTER_STATE, RTC_HEARTBEAT_TIMEOUT_MS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { probeRtcLiveness } from "./pmWatchers";

// Control message sending, ack tracking, buffering, and inbound dispatch.

// Send control event with multi-arg and optional ack callback.
export function sendControl(pm, event, args) {
  const last = args[args.length - 1];
  const cb = typeof last === "function" ? args.pop() : null;
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) {
    debugLog("transport", `[pm] buffer event=${event} (no adapter ready)`);
    termLog("switch", `buffer "${event}" (no adapter)`);
    pm._buffer.push({ event, args, cb });
    return;
  }
  debugLog("transport", `[pm] send control event=${event} via=${adapter.constructor.id}`);
  if (adapter.constructor.id === "rtc") {
    let ackId = null;
    if (cb) {
      ackId = `c_${++pm._ackSeq}`;
      pm._pendingAcks.set(ackId, cb);
      // Timeout detects zombie RTC and retries safe reads over WS or triggers restart.
      pm._scheduleAckTimeout(ackId, { event, args });
    }
    // If RTC send fails, retry alternative adapter or buffer for next available carrier.
    if (!adapter.send(CHANNELS.control, { event, args, ackId })) {
      const retry = pm._pickAdapter(CHANNELS.control);
      if (retry && retry !== adapter && retry.send(CHANNELS.control, cb ? { event, args, ackId, cb } : { event, args, ackId })) return;
      debugLog("transport", `[pm] rtc refused event=${event} → buffered`);
      pm._buffer.push({ event, args, cb });
    }
  } else {
    adapter.send(CHANNELS.control, { event, args, cb });
  }
}

export function flushBuffer(pm) {
  if (!pm._buffer.length) return;
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) return;
  // Drain buffer in one pass to prevent infinite loops on send refusals.
  const queued = pm._buffer.splice(0);
  debugLog("transport", `[pm] flush ${queued.length} buffered via=${adapter.constructor.id}`);
  for (const { event, args, cb } of queued) {
    pm._sendControl(event, cb ? [...args, cb] : args);
  }
}

// Dispatch incoming message from RTC or WS carrier.
export function dispatch(pm, event, payload, source) {
  // Cache agent capabilities on PM and forward to RTC adapter.
  if (event === "srvCaps") {
    const caps = source === "rtc" ? payload?.args?.[0] : payload;
    debugLog("transport", `[pm] srvCaps from agent via ${source}: ${JSON.stringify(caps)}`);
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
  // Renegotiate fresh offer on device approval if previous RTC attempt died while waiting.
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
  if (event === "tunnel:updated") {
    const data = source === "rtc" ? payload?.args?.[0] : payload;
    if (data) {
      const { tunnelUrl, localIp, status } = data;
      // Ignore tunnel update when current page origin is the agent workspace.
      if (typeof window !== "undefined" && pm._auth.tunnelUrl === window.location?.origin) {
        termLog("switch", `tunnel:updated ignored (carrier is the page origin; got url=${tunnelUrl || "none"})`);
        return;
      }
      termLog("switch", `tunnel:updated recv (status=${status} url=${tunnelUrl || "none"})`);
      if (status === "ready" && tunnelUrl) {
        const urlChanged = pm._auth.tunnelUrl !== tunnelUrl;
        pm._auth.tunnelUrl = tunnelUrl;
        if (localIp) pm._auth.localIp = localIp;
        pm._wsCallbacks.onUrlUpdate?.({ tunnelUrl, localIp });
        const ws = pm._adapters.get("ws");
        if (ws && (!ws.ready || urlChanged)) {
          termLog("switch", `tunnel:updated → ${urlChanged ? "url changed" : "ws not ready"} → retry ws with new URL`);
          try { ws.retryNow("tunnel-updated"); } catch {}
        }
      } else if (status === "down") {
        pm._auth.tunnelUrl = "";
        pm._wsCallbacks.onUrlUpdate?.({ tunnelUrl: "", localIp });
      }
    }
    return;
  }
  const args = source === "rtc" && Array.isArray(payload?.args)
    ? payload.args
    : [payload];
  pm._bus?.dispatch(event, args);
}

// Route incoming binary frames to their lane's bus event (file → file-bin,
// mobile video → mobile-bin; WS delivers both as file-bin, self-tagged).
export function onBinary(pm, msg) {
  if (!msg) return;
  if (msg.channel === "mobile") pm._bus?.dispatch("mobile-bin", [msg.buffer]);
  else if (msg.channel === "file") pm._bus?.dispatch("file-bin", [msg.buffer]);
}

// Idempotent read/create requests safe to retry over WS upon RTC ack timeout.
const ACK_RETRY_SAFE = new Set(["getSessions", "getWorkspaces", "bg:get", "bg:list", "ai:create", "ai:peekSeq"]);

export function scheduleAckTimeout(pm, ackId, ctx) {
  const timer = setTimeout(() => {
    pm._ackTimers.delete(ackId);
    debugLog("transport", `[pm] ack timeout ackId=${ackId} event=${ctx?.event} → suspect zombie RTC`);
    const cb = pm._pendingAcks.get(ackId);
    const rtc = pm._adapters.get("rtc");
    const ws = pm._adapters.get("ws");

    if (cb && ctx && ws?.ready && ACK_RETRY_SAFE.has(ctx.event)) {
      pm._pendingAcks.delete(ackId);
      termLog("switch", `ack-timeout ${ctx.event} → retry via ws (rtc zombie?)`);
      ws.send(CHANNELS.control, { event: ctx.event, args: ctx.args, cb });
      return;
    }

    // Ignore timeout if RTC recently received inbound traffic (slow request, not dead carrier).
    const now = Date.now();
    const rtcLastInbound = rtc?.lastInboundAt || 0;
    if (rtc?.ready && rtcLastInbound && (now - rtcLastInbound < RTC_HEARTBEAT_TIMEOUT_MS)) {
      termLog("switch", `ack-timeout ${ctx?.event || "?"} ignored (rtc active, lastInbound=${now - rtcLastInbound}ms ago)`);
      return;
    }

    // Probe silent open peer via ICE keepalive before forcing restart.
    if (rtc?.state === ADAPTER_STATE.open) {
      probeRtcLiveness(pm, `ack-timeout:${ctx?.event || "?"}`);
      return;
    }

    pm._scheduleRtcRestart("ack-timeout");
  }, pm._ackTimeoutMs);
  pm._ackTimers.set(ackId, timer);
}
