import { ADAPTER_STATE } from "@/shared/constants/transport";
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
    // Kept only for bus.id and for disconnect(); no listener lives on it, so a
    // fresh bus needs no re-binding — the bus already holds every handler.
    pm._rawSocket = ws?.socket || null;
    // "connect" is a RESERVED socket.io event (onAny never carries it), and no app
    // listener sits on the bus any more — so a carrier coming back up can only
    // reach the app from here. It is NOT announced on the first open: consumers
    // register their "connect" listener from inside the onConnect callback below,
    // and the pre-existing contract is that the first open reaches them through
    // that callback (plus terminal:ready), not through the event.
    if (isReconnect) {
      pm._maybeFireRejoin("ws", "ws reconnect while rtc ready");
    }
    if (pm._lastWsState !== ADAPTER_STATE.open) {
      // First WS open after RTC already fired onConnect → just note the tunnel
      // is up (mode/transport update); don't re-fire onConnect (handlers would
      // double-register listeners on the bus).
      if (pm._onConnectFired) {
        pm._wsCallbacks.onUrlUpdate?.({});
      } else {
        pm._onConnectFired = true;
        termLog("switch", `onConnect FIRE (ws, mode=${pm._connectionMode})`);
        // Hand consumers the bus: listeners they register there survive every
        // later carrier change on their own.
        pm._wsCallbacks.onConnect?.(pm._bus, pm._connectionMode);
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
    // get the bus and stop waiting for the tunnel. Data rides RTC.
    if (!pm._onConnectFired) {
      pm._onConnectFired = true;
      pm._connected = true;
      pm._connectionMode = "webrtc";
      termLog("switch", "onConnect FIRE (rtc, mode=webrtc)");
      pm._wsCallbacks.onConnect?.(pm._bus, pm._connectionMode);
    }
    // Successful RTC open → reset zombie recovery attempts + probe cadence
    pm._rtcRestartAttempts = 0;
    pm._probeAttempts = 0;
    pm._rtcGivenUp = false;
    pm._giveUpIp = null;
    pm._disarmRestart();
    // RTC opened → cancel any pending WS-rejoin debounce: the switch is transparent,
    // no need to reset the terminal.
    clearTimeout(pm._rejoinDebounceTimer);
    pm._rejoinDebounceTimer = null;
    const rtc = pm._adapters.get("rtc");
    if (rtc?.isLoopback) {
      termLog("switch", "rtc loopback detected (same machine) → drop ws standby");
      const ws = pm._adapters.get("ws");
      if (ws) {
        try { ws.disconnect(); } catch {}
        pm._adapters.delete("ws");
      }
    }
    // A reconnect additionally asks the panes to refetch scrollback — a heavier
    // decision than "the link is up", so it stays debounced against the other carrier.
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
