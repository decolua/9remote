import { ADAPTER_STATE, CHANNELS, NET_RECOVERY, RESUME_PROBE_TIMEOUT_MS, RESUME_PROBE_SKIP_HIDDEN_MS, RTC_RESTART, RTC_HEARTBEAT_LEGACY_TIMEOUT_MS, RTT_PROBE } from "@/shared/constants/transport";
import { isWsZombie } from "../wsZombie";
import { STREAM_EVENTS } from "../seqStream";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { selectedIceTraffic } from "./controlRouting";

// Watchers for tab visibility/freeze and network handover to trigger RTC recovery.
// Coalesces rapid visibility/resume/online events into a single recovery pass.
const RESUME_COALESCE_MS = 150;

// Reset backoff ladder on resume so reopening the app retries fast rungs.
function resetLadderOnResume(pm, reason) {
  const pendingIn = pm._rtcRestartTimer ? Math.max(pm._rtcRestartDueAt - Date.now(), 0) : -1;
  termLog("switch", `RESET attempts (was ${pm._rtcRestartAttempts}) reason=${reason} pendingIn=${pendingIn}ms`);
  pm._rtcRestartAttempts = 0;
  pm._probeAttempts = 0;
  // Pull forward long pending retry timers to the fast rung on resume.
  if (pendingIn <= RTC_RESTART.backoffMs[0]) return;
  termLog("switch", `resume: pending rung was ${pendingIn}ms out → re-arm fast`);
  pm._disarmRestart();
  pm._scheduleRtcRestart("resume-rearm");
}

// Zombie verdict + kick for a WS that looks ready but has delivered nothing for
// WS_ZOMBIE_MS — invisible to the normal retry path, which only sees open sockets.
// Returns whether the zombie was kicked.
export function kickWsZombie(pm, reason = "stale") {
  const ws = pm._adapters.get("ws");
  const wsLastAlive = Math.max(ws?.lastInboundAt ?? 0, ws?.lastMsgAt ?? 0);
  const wsZombie = ws?.ready && isWsZombie({
    ready: true,
    lastInboundAt: wsLastAlive,
    now: Date.now()
  });
  if (ws) {
    const lb = ws.lastInboundAt ?? 0;
    const lm = ws.lastMsgAt ?? 0;
    const now = Date.now();
    termLog("switch", `zombie check (${reason}): verdict=${!!wsZombie} ready=${!!ws.ready} lastPong=${lb ? `${now - lb}ms` : "never"} lastMsg=${lm ? `${now - lm}ms` : "never"}`);
  }
  if (!wsZombie) return false;
  debugLog("transport", `[pm] ws zombie (${reason}) → force reconnect`);
  try { ws.forceReconnect?.(); } catch {}
  return true;
}

// One round trip on a NAMED carrier's write path. Resolves true on a reply,
// false when the carrier refuses or the deadline passes, null when the peer
// cannot answer (old host without rttCtl). Never touches the seq ring.
export function probeAdapter(pm, adapter, reason = "probe") {
  if (!adapter?.ready) return Promise.resolve(null);
  if (!pm._srvCaps?.rttCtl) return Promise.resolve(null);
  const id = `rtt-${++pm._rttSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pm._rttPending.delete(id)) return;
      termLog("switch", `rtt probe TIMEOUT (${reason}, ${adapter.constructor.id})`);
      resolve(false);
    }, RTT_PROBE.timeoutMs);
    pm._rttPending.set(id, { timer, resolve, adapter });
    const sent = pm._sendOnAdapter(adapter, { event: STREAM_EVENTS.RTT, args: [{ id, ts: Date.now() }] });
    if (sent) return;
    clearTimeout(timer);
    pm._rttPending.delete(id);
    resolve(false);
  });
}

export function attachWatchers(pm) {
  // Health check to restart frozen RTC when tab becomes visible.
  const runResumeCheck = () => {
    termLog("switch", `visibility=${document.visibilityState}`);
    if (document.visibilityState !== "visible") return;
    const ws = pm._adapters.get("ws");
    const rtc = pm._adapters.get("rtc");
    termLog("switch", `resume check: ws=${ws?.ready ? "ready" : ws?.state} rtc=${rtc?.ready ? "ready" : rtc?.state}`);
    // Detect WS zombie when background suspension freezes keepalives while socket reports connected.
    kickWsZombie(pm, "resume");
    if (pm._awaitingApproval) return;
    // When gave up on hard NAT, re-arm only if public IP changed.
    if (pm._rtcGivenUp) {
      pm._maybeRearmRtc();
      return;
    }
    resetLadderOnResume(pm, "resume");
    // Rebuild/probe the data peer even while the signaling relay is still waking:
    // a dead RTC must not keep control pinned to it, and a restart's offer is
    // buffered until the relay is ready anyway.
    const rtcState = rtc?.state;
    if (!rtc || rtcState === ADAPTER_STATE.closed || rtcState === ADAPTER_STATE.degraded) {
      termLog("switch", `visibility → restartRtc (rtc=${rtcState || "absent"})`);
      pm._restartRtc("resume-dead-rtc");
    } else {
      // Probe DC before tearing down in case OS suspension killed it without state change.
      probeRtcOnResume(pm);
    }
    if (!pm._canSignal()) {
      // Kick the signaling relay so it can deliver the restart's offer.
      pm._sig?.retryNow("resume-no-carrier");
    }
  };

  const visibilityHandler = () => {
    if (document.visibilityState === "hidden") { pm._hiddenAt = Date.now(); return; }
    clearTimeout(pm._resumeCoalesceTimer);
    pm._resumeCoalesceTimer = setTimeout(runResumeCheck, RESUME_COALESCE_MS);
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  // Expo WebView: document.hidden never flips — native AppState bridge is the only foreground signal.
  // Dedup edge transitions: iOS fires background→inactive→active, and the bridge maps
  // inactive to hidden too — a naive set would reset _hiddenAt right before "active".
  let appHidden = false;
  const appVisibilityHandler = (e) => {
    const hidden = !!e.detail?.hidden;
    if (hidden === appHidden) return;
    appHidden = hidden;
    if (hidden) { pm._hiddenAt = Date.now(); return; }
    clearTimeout(pm._resumeCoalesceTimer);
    pm._resumeCoalesceTimer = setTimeout(runResumeCheck, RESUME_COALESCE_MS);
  };
  document.addEventListener("app-visibility", appVisibilityHandler);

  // Handle Page Lifecycle 'resume' for Android Chrome where visibilitychange may not fire.
  const resumeHandler = () => {
    if (document.visibilityState === "visible") visibilityHandler();
  };
  const freezeHandler = () => { pm._hiddenAt = Date.now(); };
  document.addEventListener("resume", resumeHandler);
  document.addEventListener("freeze", freezeHandler);

  // Network handover invalidates NAT bindings; trigger recovery on network change.
  const netHandler = () => {
    clearTimeout(pm._netDebounceTimer);
    pm._netDebounceTimer = setTimeout(() => {
      if (navigator.onLine === false) { termLog("switch", "net-change: still offline → wait"); return; }
      debugLog("transport", "[pm] network change → probe rtc");
      termLog("switch", `net-change: online=${navigator.onLine} → kick sig + ws + rtc`);
      pm._sig?.retryNow("net-change");
      // Retry WS immediately on network change to avoid waiting for backoff.
      pm.retryNow("net-change");
      // Reset restart attempts and clear give-up flag on new network.
      termLog("switch", `RESET attempts (was ${pm._rtcRestartAttempts}) givenUp=${pm._rtcGivenUp} reason=net-change`);
      pm._rtcRestartAttempts = 0;
      pm._probeAttempts = 0;
      pm._rtcGivenUp = false;
      pm._giveUpIp = null;
      if (pm._shouldRenegotiate()) pm._restartRtc("net-change");
    }, NET_RECOVERY.debounceMs);
  };
  window.addEventListener("online", netHandler);
  navigator.connection?.addEventListener?.("change", netHandler);

  // Carrier health loop — one decision point for the write path, whichever
  // carrier currently owns control. The host heartbeat only proves inbound, so
  // an idle half-dead peer stays "open" and keeps control pinned to it. Two
  // missed round trips fail over; old hosts answer nothing (no rttCtl).
  const rttMisses = new Map();
  const rttTick = async () => {
    if (document.visibilityState === "hidden") return;
    if (!pm._srvCaps?.rttCtl || pm._rttPending.size) return;
    const carrier = pm._pickAdapter?.(CHANNELS.control);
    if (!carrier?.ready) return;
    const id = carrier.constructor.id;
    const alive = await probeAdapter(pm, carrier, "tick");
    if (!carrier.ready) return; // torn down by another recovery path mid-probe
    if (alive == null) return;
    if (alive) { rttMisses.set(id, 0); return; }
    const misses = (rttMisses.get(id) || 0) + 1;
    rttMisses.set(id, misses);
    if (misses < RTT_PROBE.missesBeforeFailover) return;
    rttMisses.set(id, 0);
    termLog("switch", `rtt missed ×${RTT_PROBE.missesBeforeFailover} on ${id} → failover`);
    if (id === "rtc") {
      if (pm._adapters.get("ws")?.ready) pm.carryControlOnWs?.("rtt-miss");
      else pm._forceRestartRtc("rtt-miss");
      return;
    }
    // The tunnel owns control right now — re-dial it, the other lane takes over
    // automatically while it comes back.
    carrier.retryNow?.("rtt-miss");
  };
  const rttTimer = setInterval(rttTick, RTT_PROBE.intervalMs);

  return {
    visibilityHandler,
    detach() {
      document.removeEventListener("visibilitychange", visibilityHandler);
      document.removeEventListener("app-visibility", appVisibilityHandler);
      document.removeEventListener("resume", resumeHandler);
      document.removeEventListener("freeze", freezeHandler);
      window.removeEventListener("online", netHandler);
      navigator.connection?.removeEventListener?.("change", netHandler);
      clearTimeout(pm._netDebounceTimer);
      pm._netDebounceTimer = null;
      clearTimeout(pm._resumeCoalesceTimer);
      pm._resumeCoalesceTimer = null;
      clearInterval(rttTimer);
    }
  };
}

// Probe RTC liveness via ICE candidate-pair traffic counter delta.
export function probeRtcLiveness(pm, reason) {
  const rtc = pm._adapters.get("rtc");
  const pc = rtc?._pc;
  if (!pc || pc.connectionState === "failed") { pm._forceRestartRtc(`${reason}-pc-failed`); return; }
  // Share in-flight probe verdict for same peer to avoid pushing deadline on staggered timeouts.
  if (pm._probeLive?.rtc === rtc) {
    termLog("switch", `${reason} probe shared (already measuring this peer)`);
    return;
  }
  clearTimeout(pm._resumeProbeTimer);
  const token = ++pm._probeToken;
  pm._probeLive = { rtc, token };
  (async () => {
    const r1 = await pc.getStats();
    const a = selectedIceTraffic(r1);
    if (a == null) return null;
    await new Promise((res) => { pm._resumeProbeTimer = setTimeout(res, RESUME_PROBE_TIMEOUT_MS); });
    if (token !== pm._probeToken) return null; // superseded / disconnected
    const r2 = await pc.getStats();
    return selectedIceTraffic(r2) - a;
  })().then((delta) => {
    if (token !== pm._probeToken) return;
    const recentlyActive = rtc?.lastInboundAt && (Date.now() - rtc.lastInboundAt < RTC_HEARTBEAT_LEGACY_TIMEOUT_MS);
    if ((delta != null && delta > 0) || recentlyActive) {
      termLog("switch", `${reason} probe alive (Δ=${delta}, recent=${!!recentlyActive})`);
    } else {
      termLog("switch", `${reason} probe DEAD (Δ=${delta}) → forceRestartRtc`);
      pm._forceRestartRtc(`${reason}-probe-dead`);
    }
  }).catch(() => {
    if (token !== pm._probeToken) return;
    const recentlyActive = rtc?.lastInboundAt && (Date.now() - rtc.lastInboundAt < RTC_HEARTBEAT_LEGACY_TIMEOUT_MS);
    if (recentlyActive) {
      termLog("switch", `${reason} probe error ignored (rtc recently active)`);
      return;
    }
    termLog("switch", `${reason} probe error → forceRestartRtc`);
    pm._forceRestartRtc(`${reason}-probe-error`);
  }).finally(() => {
    if (pm._probeLive?.token === token) pm._probeLive = null;
  });
}

export function probeRtcOnResume(pm) {
  const rtc = pm._adapters.get("rtc");
  if (!rtc?.ready) { pm._restartRtc("resume-not-ready"); return; }
  // A round trip on the write path is the truth: a same-network peer usually
  // survived the suspension, and tearing it down only buys a DO negotiation.
  if (pm._srvCaps?.rttCtl) {
    probeAdapter(pm, rtc, "resume").then((alive) => {
      if (alive == null) return;
      if (alive) { termLog("switch", "resume rtt alive → keep rtc"); return; }
      if (pm._adapters.get("rtc") !== rtc) return;
      termLog("switch", "resume rtt DEAD → forceRestartRtc");
      pm._forceRestartRtc("resume-rtt-dead");
    });
    return;
  }
  // Old host: no probe reply available — keep the inbound-stats heuristics.
  // On touch devices, skip probe and restart immediately if hidden past threshold.
  const hiddenFor = pm._hiddenAt ? Date.now() - pm._hiddenAt : 0;
  const isTouch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (isTouch && hiddenFor > RESUME_PROBE_SKIP_HIDDEN_MS) {
    termLog("switch", `resume: hidden ${Math.round(hiddenFor / 1000)}s on touch → skip probe, force restart`);
    debugLog("transport", `[pm] resume: hidden ${Math.round(hiddenFor / 1000)}s → immediate restart`);
    pm._forceRestartRtc("resume-hidden-touch");
    return;
  }
  probeRtcLiveness(pm, "resume");
}
