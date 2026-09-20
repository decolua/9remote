import { ADAPTER_STATE, NET_RECOVERY, RESUME_PROBE_TIMEOUT_MS, RESUME_PROBE_SKIP_HIDDEN_MS, RTC_RESTART, RTC_HEARTBEAT_TIMEOUT_MS } from "@/shared/constants/transport";
import { isWsZombie } from "../wsZombie";
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

export function attachWatchers(pm) {
  // Health check to restart frozen RTC when tab becomes visible.
  const runResumeCheck = () => {
    termLog("switch", `visibility=${document.visibilityState}`);
    if (document.visibilityState !== "visible") return;
    const ws = pm._adapters.get("ws");
    const rtc = pm._adapters.get("rtc");
    termLog("switch", `resume check: ws=${ws?.ready ? "ready" : ws?.state} rtc=${rtc?.ready ? "ready" : rtc?.state}`);
    // Detect WS zombie when background suspension freezes keepalives while socket reports connected.
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
      termLog("switch", `zombie check: verdict=${!!wsZombie} ready=${!!ws.ready} lastPong=${lb ? `${now - lb}ms` : "never"} lastMsg=${lm ? `${now - lm}ms` : "never"}`);
    }
    if (wsZombie) {
      debugLog("transport", "[pm] ws zombie on resume → force reconnect");
      try { ws.forceReconnect?.(); } catch {}
    }
    if (pm._awaitingApproval) return;
    // When gave up on hard NAT, re-arm only if public IP changed.
    if (pm._rtcGivenUp) {
      pm._maybeRearmRtc();
      return;
    }
    resetLadderOnResume(pm, "resume");
    if (!pm._canSignal()) {
      // When all carriers are down, kick signaling relay to restart RTC once connected.
      pm._sig?.retryNow("resume-no-carrier");
      return;
    }
    const rtcState = rtc?.state;
    if (!rtc || rtcState === ADAPTER_STATE.closed || rtcState === ADAPTER_STATE.degraded) {
      termLog("switch", `visibility → restartRtc (rtc=${rtcState || "absent"})`);
      pm._restartRtc("resume-dead-rtc");
    } else {
      // Probe DC before tearing down in case OS suspension killed it without state change.
      probeRtcOnResume(pm);
    }
  };

  const visibilityHandler = () => {
    if (document.visibilityState === "hidden") { pm._hiddenAt = Date.now(); return; }
    clearTimeout(pm._resumeCoalesceTimer);
    pm._resumeCoalesceTimer = setTimeout(runResumeCheck, RESUME_COALESCE_MS);
  };
  document.addEventListener("visibilitychange", visibilityHandler);

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

  return {
    visibilityHandler,
    detach() {
      document.removeEventListener("visibilitychange", visibilityHandler);
      document.removeEventListener("resume", resumeHandler);
      document.removeEventListener("freeze", freezeHandler);
      window.removeEventListener("online", netHandler);
      navigator.connection?.removeEventListener?.("change", netHandler);
      clearTimeout(pm._netDebounceTimer);
      pm._netDebounceTimer = null;
      clearTimeout(pm._resumeCoalesceTimer);
      pm._resumeCoalesceTimer = null;
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
    const recentlyActive = rtc?.lastInboundAt && (Date.now() - rtc.lastInboundAt < RTC_HEARTBEAT_TIMEOUT_MS);
    if ((delta != null && delta > 0) || recentlyActive) {
      termLog("switch", `${reason} probe alive (Δ=${delta}, recent=${!!recentlyActive})`);
    } else {
      termLog("switch", `${reason} probe DEAD (Δ=${delta}) → forceRestartRtc`);
      pm._forceRestartRtc(`${reason}-probe-dead`);
    }
  }).catch(() => {
    if (token !== pm._probeToken) return;
    const recentlyActive = rtc?.lastInboundAt && (Date.now() - rtc.lastInboundAt < RTC_HEARTBEAT_TIMEOUT_MS);
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
