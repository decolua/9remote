import { CHANNELS, ADAPTER_STATE, RTC_HEARTBEAT_LEGACY_TIMEOUT_MS, NOT_ADMITTED, SEQ_CTL } from "@/shared/constants/transport";
import { STREAM_EVENTS } from "../seqStream";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { probeRtcLiveness } from "./pmWatchers";

// Control message sending, ack tracking, buffering, and inbound dispatch.
//
// Every control envelope is logged in the PM's replay ring and stamped with
// {sq, ep, rs}; the peer's sequencer dedupes, orders and repairs gaps. Send
// paths therefore never "lose" a message to a carrier swap — they re-send and
// let the receiver decide what is new.

// Send control event with multi-arg and optional ack callback.
export function sendControl(pm, event, args) {
  const last = args[args.length - 1];
  const cb = typeof last === "function" ? args.pop() : null;
  const ackId = cb ? registerAck(pm, event, args, cb) : null;
  const env = pm._outLog.append({ event, args, ackId });
  debugLog("transport", `[pm] send control event=${event} sq=${env.sq}`);
  ship(pm);
}

/** Acks are peer-scoped, not carrier-scoped: a lost carrier must not kill one. */
function registerAck(pm, event, args, cb) {
  const ackId = `c_${++pm._ackSeq}`;
  pm._pendingAcks.set(ackId, cb);
  pm._ackReqs?.set(ackId, { event, args, tries: 0 });
  pm._scheduleAckTimeout(ackId, { event, args, ackId });
  return ackId;
}

/** One door for every send: drain the ring's unsent tail on the best carrier.
 *  A refusal stops the drain and the next carrier event resumes it. */
export function ship(pm) {
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) return;
  for (const queued of pm._outLog.unsentList()) {
    if (!sendOn(pm, adapter, queued)) return;
    pm._outLog.markSent(queued.sq);
  }
}

function sendOn(pm, adapter, env) {
  const wire = {
    event: env.event,
    args: env.args || [],
    ackId: env.ackId ?? null,
    sq: env.sq ?? null,
    ep: pm._seqEpoch,
    rs: pm._intakeSeq.applied
  };
  if (adapter.constructor.id === "ws") {
    // socket.io cannot carry envelope fields — wrap it. The wrapper only ever
    // goes to a host that announced seqCtl, so no old peer sees it.
    if (!pm._peerSeqCtl) {
      // Unsequenced WS still has socket.io's own ack — the callback is the ack.
      const cb = env.ackId ? (...resp) => resolveAck(pm, env.ackId, resp) : null;
      return adapter.send(CHANNELS.control, cb
        ? { event: env.event, args: env.args, cb }
        : { event: env.event, args: env.args });
    }
    return adapter.send(CHANNELS.control, { event: STREAM_EVENTS.ENV, args: [wire] });
  }
  return adapter.send(CHANNELS.control, wire);
}

function resolveAck(pm, ackId, resp) {
  const cb = pm._pendingAcks.get(ackId);
  if (!cb) return;
  // Refused by a stale admission, not by the feature: hold it, repair the
  // connection, re-send after device:approved. Bounded — past the cap the
  // caller gets the refusal and shows its own "not sent".
  const req = pm._ackReqs?.get(ackId);
  if (resp?.[0]?.error === NOT_ADMITTED && req && req.tries < SEQ_CTL.admitRetryMax) {
    req.tries++;
    if (!pm._admitQueue.includes(ackId)) pm._admitQueue.push(ackId);
    termLog("switch", `not-admitted ${req.event} → hold for re-admission (try ${req.tries})`);
    recoverAdmission(pm, "ack");
    return;
  }
  pm._ackReqs?.delete(ackId);
  pm._pendingAcks.delete(ackId);
  const t = pm._ackTimers.get(ackId);
  if (t) { clearTimeout(t); pm._ackTimers.delete(ackId); }
  cb(...(resp || []));
}

export function sendStreamEvent(pm, event, arg, ackId = null) {
  pm._outLog.append({ event, args: arg === undefined ? [] : [arg], ackId });
  ship(pm);
}

/** A carrier event — replay the unconfirmed window (lane switch loses nothing),
 *  then resume gap repair. The host's sequencer dedupes what it already had. */
export function flushBuffer(pm) {
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) return;
  pm._intakeSeq.setPaused(false);
  for (const queued of pm._outLog.replayList()) {
    if (!sendOn(pm, adapter, queued)) return;
    pm._outLog.markSent(queued.sq);
  }
}

/** Deliver one envelope to its handlers exactly once (sequencer output). */
export function deliver(pm, env) {
  switch (env.event) {
    case STREAM_EVENTS.ACK:
      return dispatchAck(pm, env);
    case STREAM_EVENTS.GAP:
      return serveGap(pm, env.args?.[0]);
    case STREAM_EVENTS.GAP_MISS:
      return pm._intakeSeq.gapMissed(env.args?.[0]?.from);
    default:
      break;
  }
  // Ack replies may arrive on a different carrier than the request left on.
  if (env.ackId && pm._pendingAcks.has(env.ackId)) return resolveAck(pm, env.ackId, env.args);
  handleControlEvent(pm, env);
}

function dispatchAck(pm, env) {
  resolveAck(pm, env.ackId, env.args);
}

function serveGap(pm, { from, to } = {}) {
  const range = pm._outLog.range(from, to);
  if (!range) { sendStreamEvent(pm, STREAM_EVENTS.GAP_MISS, { from }); return; }
  const adapter = pm._pickAdapter(CHANNELS.control);
  if (!adapter) return;
  for (const env of range) if (!sendOn(pm, adapter, env)) break;
}

// Dispatch incoming message from RTC or WS carrier.
export function dispatch(pm, event, payload, source) {
  // WS carries the envelope wrapper (payload IS the wire — adapters hand us the
  // event's first arg); RTC carries two shapes: a control envelope (args array)
  // or bare lane data (tiles) that must arrive as the single first arg.
  let env;
  if (event === STREAM_EVENTS.ENV) env = payload;
  else if (source === "rtc") {
    env = Array.isArray(payload?.args)
      ? { ...payload, event }
      : { event, args: [payload], ackId: null, sq: null, ep: null };
  }
  else env = { event, args: [payload], ackId: null };
  if (!env?.event) return;
  if (Number.isInteger(env.rs)) pm._outLog.setApplied(env.rs);
  if (Number.isInteger(env.sq) && !pm._intakeSeq.armed && pm._peerSeqCtl) pm._intakeSeq.arm();
  pm._intakeSeq.push(env);
}

/** The host's admission for this PM went stale (its connection closed under a live
 *  carrier). Re-dial one carrier so the host admits a fresh connection; the held
 *  requests ride again on the device:approved that follows. */
export function recoverAdmission(pm, reason) {
  const now = Date.now();
  if (now - pm._admitKickAt < SEQ_CTL.admitKickMinMs) return;
  pm._admitKickAt = now;
  const ws = pm._adapters.get("ws");
  termLog("switch", `admission stale (${reason}) → re-dial ${ws ? "ws" : "rtc"}`);
  if (ws?.forceReconnect) { try { ws.forceReconnect(); } catch {} return; }
  pm._forceRestartRtc?.("not-admitted");
}

function resendAdmitQueue(pm) {
  const queue = pm._admitQueue.splice(0);
  if (!queue.length) return;
  termLog("switch", `re-admitted → re-send ${queue.length} held request(s)`);
  for (const ackId of queue) {
    const req = pm._ackReqs.get(ackId);
    if (!req || !pm._pendingAcks.has(ackId)) continue;
    pm._outLog.append({ event: req.event, args: req.args, ackId });
  }
  ship(pm);
}

/** Application-level events that must run before/sidestep the sequencer. */
export function handleControlEvent(pm, env) {
  const { event } = env;
  const args = Array.isArray(env.args) ? env.args : [];
  if (event === "srvCaps") {
    const caps = args[0] ?? env;
    debugLog("transport", `[pm] srvCaps from host: ${JSON.stringify(caps)}`);
    pm._srvCaps = caps || {};
    if (caps?.seqCtl && !pm._peerSeqCtl) {
      pm._peerSeqCtl = true;
      termLog("switch", "host announced seqCtl → sequenced control stream active");
    }
    pm._adapters.get("rtc")?.setPeerCaps?.(pm._srvCaps);
    return;
  }
  if (event === "conn:notAdmitted") {
    recoverAdmission(pm, "notice");
    return;
  }
  if (event === "device:approved") {
    pm._awaitingApproval = false;
    resendAdmitQueue(pm);
    const rtc = pm._adapters.get("rtc");
    if (pm._canSignal() && (!rtc || rtc.state === ADAPTER_STATE.closed)) pm._restartRtc("device-approved");
  }
  if (event === "rtc:enabled") {
    if (pm._rtcTestDisabled) {
      pm._rtcTestDisabled = false;
      termLog("switch", "rtc:enabled by host → clear flag + restart RTC");
      pm._restartRtc("rtc-enabled");
    }
    return;
  }
  if (event === "tunnel:updated") {
    handleTunnelUpdated(pm, args[0]);
    return;
  }
  pm._bus?.dispatch(event, args);
}

function handleTunnelUpdated(pm, data) {
  if (!data) return;
  const { tunnelUrl, localIp, status } = data;
  // Ignore tunnel update when current page origin is the host workspace.
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

// Route incoming binary frames to their lane's bus event (file → file-bin,
// mobile video → mobile-bin; WS delivers both as file-bin, self-tagged).
export function onBinary(pm, msg) {
  if (!msg) return;
  if (msg.channel === "mobile") pm._bus?.dispatch("mobile-bin", [msg.buffer]);
  else if (msg.channel === "file") pm._bus?.dispatch("file-bin", [msg.buffer]);
}

// Idempotent read/create requests safe to retry over WS upon RTC ack timeout.
const ACK_RETRY_SAFE = new Set(["getSessions", "getWorkspaces", "bg:get", "bg:list", "ai:create", "ai:peekSeq", "aiSince"]);

export function scheduleAckTimeout(pm, ackId, ctx) {
  const timer = setTimeout(() => {
    pm._ackTimers.delete(ackId);
    debugLog("transport", `[pm] ack timeout ackId=${ackId} event=${ctx?.event} → suspect zombie RTC`);
    const cb = pm._pendingAcks.get(ackId);
    const rtc = pm._adapters.get("rtc");
    const ws = pm._adapters.get("ws");
    // Held for re-admission: the carrier is fine, the host just has not re-admitted yet.
    if (pm._admitQueue?.includes(ackId)) return;

    // Stream active: the request re-sends itself on whichever carrier is up and
    // the host answers once, so a missing ack is not a zombie signal — leave it
    // pending (the caller's own timeout covers a peer that truly died).
    if (pm._seqActive() && cb) {
      termLog("switch", `ack-timeout ${ctx?.event} → keep pending (sequenced stream owns retry)`);
      return;
    }

    if (cb && ctx && ws?.ready && ACK_RETRY_SAFE.has(ctx.event)) {
      pm._pendingAcks.delete(ackId);
      termLog("switch", `ack-timeout ${ctx.event} → retry via ws (rtc zombie?)`);
      ws.send(CHANNELS.control, { event: ctx.event, args: ctx.args, cb });
      return;
    }

    // Ignore timeout if RTC recently received inbound traffic (slow request, not dead carrier).
    const now = Date.now();
    const rtcLastInbound = rtc?.lastInboundAt || 0;
    if (rtc?.ready && rtcLastInbound && (now - rtcLastInbound < RTC_HEARTBEAT_LEGACY_TIMEOUT_MS)) {
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
