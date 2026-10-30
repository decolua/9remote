import { TRANSPORT_PROFILES, RTC_RESTART } from "@/shared/constants/transport";
import { randomTag } from "./controlRouting";
import { createOutboundLog, createIntake, newEpoch, STREAM_EVENTS } from "../seqStream";
import { SEQ_CTL } from "@/shared/constants/transport";
import { termLog } from "@/shared/utils/termLog";
import { deliver } from "./pmMessaging";

// Legacy wsConfig/rtcConfig → the unified shape the manager runs on.
// Pure: no timers, no listeners, no adapters.
// Extracted verbatim from the ProtocolManager constructor.
export function buildConfig(wsConfig, rtcConfig) {
  const profileId = rtcConfig?.enableWebRTC ? "remoteDesktop" : "clientApp";
  const profile = { ...TRANSPORT_PROFILES[profileId] };
  if (!rtcConfig?.enableWebRTC) profile.enabled = ["ws"];
  if (rtcConfig?.enableTurn) profile.rtc = { ...profile.rtc, enableTurn: true };

  const auth = {
    tunnelUrl: wsConfig.tunnelUrl,
    localIp: wsConfig.localIp,
    apiKey: wsConfig.apiKey,
    tempKey: wsConfig.tempKey,
    deviceId: wsConfig.deviceId,
    namespace: wsConfig.namespace,
    socketOptions: wsConfig.socketOptions
  };

  const wsCallbacks = {
    onConnect: wsConfig.onConnect,
    onDisconnect: wsConfig.onDisconnect,
    onRetryStatus: wsConfig.onRetryStatus,
    onUrlUpdate: wsConfig.onUrlUpdate,
    onApproval: wsConfig.onApproval,
    onHostOffline: wsConfig.onHostOffline
  };

  const rtcCallbacks = rtcConfig ? {
    onUpgrade: rtcConfig.onUpgrade,
    onFallback: rtcConfig.onFallback,
    onTransportChange: rtcConfig.onTransportChange
  } : {};

  // Signaling identity — per PM instance, so two tabs of the same browser
  // (same deviceId, shared localStorage) get independent RTC sessions.
  const peerId = `${wsConfig.deviceId}:${randomTag()}`;
  // Socket.io carries the peerId so the host can match a tunnel connection to
  // an existing RTC-only session instead of building a second PM.
  if (auth.socketOptions?.auth) auth.socketOptions.auth.peerId = peerId;

  return { profile, auth, wsCallbacks, rtcCallbacks, peerId };
}

/** Mutable runtime state, all at their session-start values. */
export function initialState() {
  return {
    _adapters: new Map(),   // id → adapter instance
    _pendingAcks: new Map(), // ackId → callback (carrier-agnostic)
    _ackTimers: new Map(),  // ackId → timeout (zombie detection)
    _ackSeq: 0,

    // RTC zombie recovery — restart with backoff when acks time out (dead-but-open DC)
    _rtcRestartAttempts: 0,
    _rtcRestartTimer: null,
    _rtcRestartDueAt: 0,   // when the pending rung fires — diagnostics for the SKIP guard
    _probeAttempts: 0,     // escalating-probe index (probeBackoffMs)
    _rtcGivenUp: false,    // hard NAT detected → WS-only until network changes
    _giveUpIp: null,       // public IP at give-up — re-arm only when it changes
    _lastStunProbeAt: 0,   // rate-limit the standalone STUN probe
    // Debounce a WS-driven rejoin while RTC is mid-handshake (resume case) so the
    // terminal isn't reset right before RTC opens — cleared on RTC open / disconnect.
    _rejoinDebounceTimer: null,
    // Public IP last seen via STUN — identity of the network we negotiated on.
    _netFingerprint: null,
    // Set when the host answers "not approved" — pauses RTC recovery until the
    // host acts, so we don't spin offers the host will only refuse again.
    _awaitingApproval: false,
    _ackTimeoutMs: RTC_RESTART.ackTimeoutMs,

    // Resume-from-background probe state. OS suspends the tab → iceConnectionState
    // events deferred → RTC may report "open" while dead. Track when we went hidden
    // so the visibility handler can probe-then-restart instead of blind-restarting.
    _hiddenAt: null,
    _resumeProbeTimer: null,
    _probeToken: 0,
    _probeLive: null,       // { rtc, token } — the probe currently measuring

    _connected: false,
    _type: "ws",
    _connectionMode: "tunnel",
    _lastWsState: null,
    _rawSocket: null,
    // onConnect fires once when the FIRST adapter opens (RTC or WS) so the app is
    // usable before the tunnel comes up. Without this, workspace hooks wait for WS
    // and fail with "Connection Failed" when the tunnel is slow/dead.
    _onConnectFired: false,

    // Cross-adapter signaling — RTC pulls this from connect ctx
    _rtcSignalingHandler: null,
    // DO signaling relay (fallback carrier). Lazy-init in connect() once deviceId is known.
    _sig: null,
    _sigDestroyed: false,
    // Outbound signaling that arrived before any carrier was ready (RTC created
    // its offer before the tunnel WS or DO relay finished connecting). Flushed
    // the moment either carrier opens.
    _sigBuffer: [],
    _wsFallbackTimer: null,

    // Sequenced control stream — outbound replay ring + one-door inbound
    // sequencer. See seqStream.js; armed once the host announces caps.seqCtl.
    _peerSeqCtl: false,
    _seqEpoch: newEpoch(),
    _outLog: createOutboundLog({ maxBytes: SEQ_CTL.ringMaxBytes, maxEntries: SEQ_CTL.maxEntries }),
    _intakeSeq: null // built by the PM constructor (needs `deliver`, which needs the PM)
  };
}

/** Sequencer factory — separated so the PM can bind its own deliver(). */
export function createIntakeFor(pm) {
  return createIntake({
    holdMax: SEQ_CTL.holdMax,
    gapDeadlineMs: SEQ_CTL.gapDeadlineMs,
    deliver: (env) => deliver(pm, env),
    requestGap: (from, to) => pm._sendStreamEvent(STREAM_EVENTS.GAP, { from, to }),
    onLoss: (from, to) => { pm._seqLosses = (pm._seqLosses || 0) + 1; termLog("switch", `seq skipped ${from}..${to} (ring evicted)`); },
    onDupe: () => { pm._seqDupes = (pm._seqDupes || 0) + 1; }
  });
}
