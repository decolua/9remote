import { ADAPTER_STATE, NET_RECOVERY, RESUME_PROBE_TIMEOUT_MS } from "@/shared/constants/transport";
import { isWsZombie } from "../wsZombie";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { selectedIceResponses } from "./controlRouting";

// Environment watchers for the transport: tab visibility/resume/freeze and network
// handover. Both classes of event invalidate an RTC peer well before its own timers
// notice, so they drive the recovery paths on the PM.
// Extracted verbatim from ProtocolManager — pm is the manager instance.
export function attachWatchers(pm) {
  // Visibility-based RTC health check — restart frozen RTC when tab becomes visible.
  // WS may survive background suspension (socket.io keepalive) while the RTC
  // PeerConnection freezes/closes; without this, RTC never recovers on resume.
  const visibilityHandler = () => {
    termLog("switch", `visibility=${document.visibilityState}`);
    if (document.visibilityState !== "visible") {
      if (document.visibilityState === "hidden") pm._hiddenAt = Date.now();
      return;
    }
    const ws = pm._adapters.get("ws");
    const rtc = pm._adapters.get("rtc");
    termLog("switch", `resume check: ws=${ws?.ready ? "ready" : ws?.state} rtc=${rtc?.ready ? "ready" : rtc?.state}`);
    // WS zombie: socket.io still reports connected after background suspension
    // froze its pings, so it looks ready but no bytes flow (terminal/remote go
    // dead with NO disconnect modal, and only an app reload recovers). Break the
    // zombie socket so the normal reconnect path replaces it.
    // lastInboundAt comes from Engine.IO "pong" (true liveness, independent of
    // app traffic or RTC) so an idle-but-alive WS is never mistaken for a zombie.
    // Use the FRESHEST of pong and app-event: a carrier that still delivers app
    // bytes is alive even if the server's pingInterval is long/disabled, and an
    // idle socket is kept alive by pong. Only when BOTH go stale is it a zombie.
    const wsLastAlive = Math.max(ws?.lastInboundAt ?? 0, ws?.lastMsgAt ?? 0);
    const wsZombie = ws?.ready && isWsZombie({
      ready: true,
      lastInboundAt: wsLastAlive,
      now: Date.now()
    });
    // TEMP DIAGNOSTIC — compare pong liveness vs app-event liveness.
    // lastInbound = pong heartbeat; lastMsg = app event over WS. If lastMsg
    // stays fresh while lastInbound goes stale, pong stamping is the bug.
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
    // WS not ready but not a zombie → leave it alone. WsProtocol's own
    // visibility handler already calls _forceReconnect, and calling retryNow
    // here would kill a healthy mid-handshake socket on every tab focus →
    // onConnect → handleSocketReady → UI flash.
    // Signaling rides the tunnel WS *or* the DO relay — an RTC-only session
    // has no ws adapter at all, so gating on WS here left it stuck forever.
    if (pm._awaitingApproval) return; // host hasn't approved yet — nothing to retry
    // Gave up on hard NAT → only a REAL network change can make RTC viable again.
    // Ask STUN for the current public IP (no DO call) and compare; a timer would
    // re-spam the DO on every long app switch even though the NAT never moved.
    if (pm._rtcGivenUp) {
      // The probe decides asynchronously whether to re-arm; nothing else on the
      // resume path should touch RTC while we're WS-only.
      pm._maybeRearmRtc();
      return;
    }
    if (!pm._canSignal()) {
      // Both carriers down (background froze them too) — kick the relay and
      // let its onReady restart RTC once a path exists again.
      pm._sig?.retryNow();
      return;
    }
    const rtcState = rtc?.state;
    if (!rtc || rtcState === ADAPTER_STATE.closed || rtcState === ADAPTER_STATE.degraded) {
      termLog("switch", `visibility → restartRtc (rtc=${rtcState || "absent"})`);
      pm._restartRtc();
    } else {
      // RTC reports open/connecting — but OS suspension often kills the DC
      // without firing an iceConnectionState change. Probe the DC before
      // tearing down; only force a restart if the probe times out.
      probeRtcOnResume(pm);
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  // Page Lifecycle: a tab returning from frozen→active may NOT fire
  // visibilitychange (Chrome 77+ Android) — only `resume`. Treat it the same.
  const resumeHandler = () => {
    if (document.visibilityState === "visible") visibilityHandler();
  };
  const freezeHandler = () => { pm._hiddenAt = Date.now(); };
  document.addEventListener("resume", resumeHandler);
  document.addEventListener("freeze", freezeHandler);

  // Network handover (wifi ⇄ cellular ⇄ another AP) invalidates the NAT
  // bindings ICE negotiated, so RTC is dead well before its own timers notice.
  // Both signals are hints only (onLine is unreliable per MDN; the Network
  // Information API is missing on Safari) — the srflx check does the deciding.
  const netHandler = () => {
    clearTimeout(pm._netDebounceTimer);
    pm._netDebounceTimer = setTimeout(() => {
      if (navigator.onLine === false) return; // still down — wait for "online"
      debugLog("transport", "[pm] network change → probe rtc");
      pm._sig?.retryNow();
      // Fresh network deserves a fresh budget, else a session that burned its
      // 3 restarts on a bad network is locked to the tunnel forever. A network
      // change also means the NAT may differ → clear any give-up and try again.
      termLog("switch", `RESET attempts (was ${pm._rtcRestartAttempts}) givenUp=${pm._rtcGivenUp} reason=net-change`); // TEMP DIAGNOSTIC
      pm._rtcRestartAttempts = 0;
      pm._probeAttempts = 0;
      pm._rtcGivenUp = false;
      pm._giveUpIp = null;
      // No carrier yet — the relay just reconnected; its onReady fires the
      // restart. Renegotiating now would only buffer an offer nobody reads.
      if (pm._shouldRenegotiate()) pm._restartRtc();
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
    }
  };
}

/** On resume from background, RTC may report "open" while the DC is actually
 *  dead (OS suspension froze ICE without firing state changes). Sample
 *  getStats() across the window — STUN keepalives grow responsesReceived on a
 *  live DC; a flat counter means zombie → force a restart. Browser-only, no
 *  agent cooperation (and no DO signaling round-trip on a healthy resume). */
export function probeRtcOnResume(pm) {
  const rtc = pm._adapters.get("rtc");
  if (!rtc?.ready) { pm._restartRtc(); return; }
  const pc = rtc._pc;
  if (!pc || pc.connectionState === "failed") { pm._forceRestartRtc(); return; }
  // Browser-only probe (no agent cooperation): sample the selected ICE
  // candidate-pair's responsesReceived across the window. ICE sends STUN
  // keepalives continuously — even with no app traffic — so a live DC grows
  // this counter; a frozen/zombie DC stays flat. Avoids a DO round-trip per
  // resume and needs no new agent event.
  clearTimeout(pm._resumeProbeTimer);
  const token = ++pm._probeToken;
  const sample = async () => {
    const r1 = await pc.getStats();
    const a = selectedIceResponses(r1);
    if (a == null) return null;
    await new Promise((res) => { pm._resumeProbeTimer = setTimeout(res, RESUME_PROBE_TIMEOUT_MS); });
    if (token !== pm._probeToken) return null; // superseded / disconnected
    const r2 = await pc.getStats();
    return selectedIceResponses(r2) - a;
  };
  sample().then((delta) => {
    if (token !== pm._probeToken) return;
    if (delta != null && delta > 0) {
      termLog("switch", `resume probe getStats alive (Δ=${delta})`);
      debugLog("transport", `[pm] resume probe alive (delta=${delta})`);
    } else {
      termLog("switch", `resume probe getStats dead (Δ=${delta}) → forceRestartRtc`);
      debugLog("transport", `[pm] resume probe dead (delta=${delta}) → restart rtc`);
      pm._forceRestartRtc();
    }
  }).catch(() => {
    if (token !== pm._probeToken) return;
    termLog("switch", "resume probe getStats error → forceRestartRtc");
    pm._forceRestartRtc();
  });
}
