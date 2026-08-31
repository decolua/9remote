// Active protocol registry — PMs survive socket disconnect (grace period for RTC fallback)
import { createLogger } from "../lib/logger.js";

const logger = createLogger("broadcast");
const active = new Set();

export function registerProtocol(pm) {
  active.add(pm);
  logger.debug(`register peer=${pm._deviceId?.slice(0, 12)} active=${active.size}`);
}
export function unregisterProtocol(pm) {
  active.delete(pm);
  logger.debug(`unregister peer=${pm._deviceId?.slice(0, 12)} active=${active.size}`);
}

// Snapshot of live PMs — kick/cleanup paths sweep this by device
export function activeProtocols() {
  return [...active];
}

// Live carrier counts for the UI transport badges
export function getTransportStats() {
  let rtcPeers = 0, wsPeers = 0;
  for (const pm of active) {
    if (pm._adapters?.get("rtc")?.ready) rtcPeers++;
    if (pm._adapters?.get("ws")?.ready) wsPeers++;
  }
  return { rtcPeers, wsPeers };
}

// Tear down the RTC adapter on every active PM (test-toggle "disable RTC").
// Needed because after the signaling-deviceId fix, RTC lives inside the WS-hosted
// PM (real socket host), not in rtcSessions — so looping rtcSessions alone is a
// no-op. The client sees the PeerConnection close and falls back to the tunnel.
export function disableAllRtc() {
  for (const pm of active) {
    try {
      const rtc = pm._adapters?.get("rtc");
      const ws = pm._adapters?.get("ws");
      logger.debug(`disableAllRtc peer=${pm._deviceId?.slice(0, 12)} rtc=${rtc?.state || "absent"} ws=${ws?.state || "absent"} virtual=${!!pm._host?.defersWsAdapter}`);
      if (rtc) { try { rtc.disconnect(); } catch {} pm._adapters.delete("rtc"); }
      pm._rtcSignalingHandler = null;
      // Unregister the signalingGlobal handler so new offers find no PM → flow into
      // handleRtcOffer → refused with "rtc-disabled" → client stops retrying.
      try { pm._offGlobalSig?.(); } catch {}
      pm._offGlobalSig = null;
    } catch (e) { logger.warn(`disableAllRtc failed: ${e.message}`); }
  }
  logger.debug(`disableAllRtc: cleared RTC on ${active.size} PM(s)`);
}

// server.js registers this — broadcast must stay importable from features
// (remoteSocket) without importing server.js back (cycle).
let _rtcSessionKiller = null;
export function setRtcSessionKiller(fn) { _rtcSessionKiller = fn; }

/** Dispose a PM AND the RTC-first session it hosts. pm.close()/unregister alone
 *  leave the AgentBus's tracked entry and rtcSessions record behind — a
 *  closed browser then shows as online forever (each tab/reload = one leak). */
export function disposeProtocol(pm) {
  if (!pm) return;
  try { pm.close(); } catch {}
  unregisterProtocol(pm);
  if (pm._host?.defersWsAdapter && _rtcSessionKiller) _rtcSessionKiller(pm._host.peerId);
}

// Notify every active PM that RTC is enabled again (test-toggle off) — clients
// clear their stop-retry flag and renegotiate. Re-registers the signalingGlobal
// handler that disableAllRtc cleared, so the next offer finds this PM (answer)
// instead of spawning a second RTC-only PM.
export function notifyRtcEnabled() {
  for (const pm of active) {
    try {
      // Re-register the signalingGlobal handler (cleared by disableAllRtc) and
      // recreate the RTC adapter (answerer) so the client's next offer is answered
      // by this PM — otherwise signalingGlobal finds no handler and spawns a second
      // RTC-only PM (duplicate output).
      if (!pm._offGlobalSig && typeof pm.setupSignaling === "function") {
        pm.setupSignaling(pm._socket);
      }
      if (typeof pm.restartRtc === "function") pm.restartRtc();
      pm.emit("rtc:enabled", {});
      logger.debug(`notifyRtcEnabled peer=${pm._deviceId?.slice(0, 12)} re-armed RTC`);
    } catch (e) { logger.warn(`notifyRtcEnabled failed: ${e.message}`); }
  }
  logger.debug(`notifyRtcEnabled: signaled ${active.size} PM(s)`);
}

// Duplicate output is per-frame, so warn at most once per peer-set per interval.
const DUPLICATE_WARN_INTERVAL_MS = 10_000;
let lastDuplicateKey = "";
let lastDuplicateAt = 0;

function warnDuplicate(peers, targets) {
  const key = [...peers].sort().join("|");
  const now = Date.now();
  if (key === lastDuplicateKey && now - lastDuplicateAt < DUPLICATE_WARN_INTERVAL_MS) return;
  lastDuplicateKey = key;
  lastDuplicateAt = now;
  logger.warn(`DUPLICATE: output same peer twice: ${targets.join(", ")}`);
}

// Broadcast event to all active PMs (routes via best adapter — RTC if WS down).
// If 2 PMs share one peerId (RTC-first AgentBus + WS race) the client gets duplicate output.
export function broadcast(_io, event, data) {
  const peers = [];
  const targets = [];
  for (const pm of active) {
    // Skip PMs with no ready adapter — avoids buffering into dying/orphan PMs
    if (!pm.hasReadyAdapter?.()) continue;
    peers.push(pm._deviceId || "");
    targets.push(`${pm._deviceId?.slice(0, 12)}:${pm.type}`);
    try { pm.emit(event, data); } catch (e) { logger.warn(`emit ${event} failed: ${e.message}`); }
  }
  // Compare the FULL peerId ("deviceId:tab") — distinct tabs of one device are legit.
  if (event === "output") {
    if (new Set(peers).size !== peers.length) warnDuplicate(peers, targets);
    return;
  }
  logger.debug(`bc ${event} → ${targets.length} target(s)`);
}
