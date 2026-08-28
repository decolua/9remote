import { ADAPTER_STATE } from "@/shared/constants/transport";
import { rebindProxyListeners } from "./proxySocket";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

// Per-carrier state transitions. These decide when onConnect / onDisconnect /
// rejoin fire, so the rules are load-bearing: a carrier going down while the
// other still carries data must stay invisible to the app.
// Extracted verbatim from ProtocolManager._onAdapterStateChange.

export function handleWsStateChange(pm, state) {
  const ws = pm._adapters.get("ws");
  if (state === ADAPTER_STATE.open) {
    const isReconnect = pm._lastWsState === ADAPTER_STATE.degraded;
    pm._connected = true;
    pm._connectionMode = ws?.connectionMode || "tunnel";
    pm._rawSocket = ws?.socket || null;
    // Re-attach proxy listeners to new raw socket
    rebindProxyListeners(pm._rawSocket, pm._proxySocket);
    // On WS reconnect (resume from background), the new socket is already
    // connected by the time we bind "connect" handlers — Socket.IO won't fire
    // the event again. Manually notify so terminal panes rejoin for fresh
    // scrollback.
    if (isReconnect) {
      pm._maybeFireRejoin("ws", "ws reconnect while rtc ready");
    }
    if (pm._lastWsState !== ADAPTER_STATE.open) {
      // First WS open after RTC already fired onConnect → just note the tunnel
      // is up (mode/transport update); don't re-fire onConnect (handlers would
      // double-register listeners on the proxy).
      if (pm._onConnectFired) {
        pm._wsCallbacks.onUrlUpdate?.({});
      } else {
        pm._onConnectFired = true;
        termLog("switch", `onConnect FIRE (ws, mode=${pm._connectionMode})`);
        // Pass proxy socket so consumer's onConnect handlers register listeners on PROXY
        // (which auto re-binds to new raw socket after reconnect)
        pm._wsCallbacks.onConnect?.(pm._proxySocket, pm._connectionMode);
      }
    }
    // RTC is started from connect() (signaling via DO, independent of WS).
    // WS reconnect no longer needs to renegotiate RTC — the DO relay carries
    // signaling without the tunnel.
  } else {
    pm._rawSocket = null;
    if (pm._lastWsState === ADAPTER_STATE.open) {
      termLog("switch", "ws down");
      // Whether the app hears about it is decided in PM._onAdapterStateChange,
      // which sees BOTH carriers — this branch only knows about ws.
      if (pm._anyAdapterReady()) termLog("switch", "ws down but rtc alive → skip onDisconnect");
    }
  }
  pm._lastWsState = state;
}

export function handleRtcStateChange(pm, state) {
  if (state === ADAPTER_STATE.open) {
    const isRtcReconnect = pm._onConnectFired;
    clearTimeout(pm._wsFallbackTimer);
    pm._rtcCallbacks.onUpgrade?.(pm._adapters.get("rtc")?.typeDetail || "dc-stun");
    // RTC opened first (tunnel not up yet) — fire onConnect so workspace hooks
    // get the proxy socket and stop waiting for the tunnel. Data rides RTC.
    if (!pm._onConnectFired) {
      pm._onConnectFired = true;
      pm._connected = true;
      pm._connectionMode = "webrtc";
      termLog("switch", "onConnect FIRE (rtc, mode=webrtc)");
      pm._wsCallbacks.onConnect?.(pm._proxySocket, pm._connectionMode);
    }
    // Successful RTC open → reset zombie recovery attempts + probe cadence
    termLog("switch", `RESET attempts (was ${pm._rtcRestartAttempts}) reason=rtc-open`); // TEMP DIAGNOSTIC
    pm._rtcRestartAttempts = 0;
    pm._probeAttempts = 0;
    pm._rtcGivenUp = false;
    pm._giveUpIp = null;
    pm._disarmRestart();
    // RTC opened → cancel any pending WS-rejoin debounce: the switch is transparent,
    // no need to reset the terminal.
    clearTimeout(pm._rejoinDebounceTimer);
    pm._rejoinDebounceTimer = null;
    // On RTC reconnect (resume from background/mobility), fire "connect" on the
    // proxy so terminal panes rejoin and fetch fresh scrollback. The proxy was
    // already bound during first open — this just re-notifies listeners the
    // transport is ready again (mirrors WS reconnect path).
    if (isRtcReconnect) {
      pm._maybeFireRejoin("rtc", "rtc reconnect while ws ready");
    }
  }
  if (state === ADAPTER_STATE.closed) {
    pm._rtcCallbacks.onFallback?.("ws");
    termLog("switch", "rtc closed → startWsFallback + scheduleRtcRestart");
    // RTC down → bring up the WS tunnel now so there's a data path while RTC
    // retries via DO. If RTC comes back, _pickAdapter prefers it again.
    pm._startWsFallback();
    clearTimeout(pm._wsFallbackTimer);
    // Reject acks of requests sent over the now-dead RTC DC so callers fail
    // fast instead of hanging until the 30s cleanup silently drops them.
    for (const cb of pm._pendingAcks.values()) {
      try { cb({ error: "rtc-closed" }); } catch {}
    }
    pm._pendingAcks.clear();
    for (const t of pm._ackTimers.values()) clearTimeout(t);
    pm._ackTimers.clear();
    // RTC died → retry RTC via DO signaling (STUN again). Only after maxAttempts
    // of repeated failure does the tunnel (ws) own the session permanently.
    pm._scheduleRtcRestart("rtc-closed");
  }
}
