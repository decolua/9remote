import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { registerProtocol, getProtocol } from "./registry";
import { CHANNELS, ADAPTER_STATE, REJOIN_DEBOUNCE_MS, RTC_CONNECT_TIMEOUT_MS, RTC_DEFER_MAX_MS, STUN_PROBE } from "@/shared/constants/transport";
import { probePublicIp, shouldRearmOnIpChange, NO_PUBLIC_IP } from "./stunProbe";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { createClientBus } from "./lib/clientBus";
import { pickAdapter } from "./lib/controlRouting";
import { nextRestartStep, restartTimerAction, restartRtcAction, peerDeadline } from "./lib/rtcRecoveryPolicy";
import { attachWatchers, kickWsZombie } from "./lib/pmWatchers";
import { handleWsStateChange, handleRtcStateChange } from "./lib/adapterStateHandlers";
import { buildConfig, initialState } from "./lib/pmConfig";
import { initSignalingClient, handleApprovalSignal, onSignalingReady, sendSignaling, flushSigBuffer, refreshTunnelUrl } from "./lib/pmSignaling";
import { sendControl, flushBuffer, dispatch, onBinary, scheduleAckTimeout } from "./lib/pmMessaging";
import { handleDeviceAuthEvent, maybeSendTailProof, DEVICE_AUTH_EVENTS } from "./lib/deviceTrust";

registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

export class ProtocolManager {
  constructor(wsConfig, rtcConfig) {
    const { profile, auth, wsCallbacks, rtcCallbacks, peerId } = buildConfig(wsConfig, rtcConfig);
    this._profile = profile;
    this._auth = auth;
    this._wsCallbacks = wsCallbacks;
    this._rtcCallbacks = rtcCallbacks;
    this._peerId = peerId;
    Object.assign(this, initialState());

    // Outlives carriers so app listeners persist across carrier switches.
    this._bus = createClientBus(this);
    this.busRef = { current: this._bus };
    for (const ev of DEVICE_AUTH_EVENTS) {
      this._bus.on(ev, (data) => handleDeviceAuthEvent(this, ev, data));
    }
    this._watchers = attachWatchers(this);
  }

  get type() { return this._type; }
  get connected() { return this._connected; }
  get connectionMode() { return this._connectionMode; }
  get wsBlocked() { return this._adapters.get("ws")?.blocked || false; }

  setWsBlocked(blocked) {
    this._adapters.get("ws")?.setBlocked(blocked);
  }

  setUpdating(updating) {
    this._adapters.get("ws")?.setUpdating(updating);
  }

  retryNow(reason = "user") {
    const ws = this._adapters.get("ws");
    if (ws) { ws.retryNow?.(reason); return; }
    termLog("switch", `retryNow by=${reason}: no ws adapter → full connect()`);
    this.connect();
  }

  // Probe a ready-but-silent WS (zombie) and force-reconnect it; true when kicked.
  kickWsZombie(reason = "stale") {
    return kickWsZombie(this, reason);
  }

  emit(event, ...args) {
    this._sendControl(event, args);
  }

  sendBinary(channel, payload) {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
  }

  connect() {
    // Connect RTC and WS in parallel: RTC preferred, WS warm standby for instant failover.
    this._sigDestroyed = false;
    const hasRtc = this._profile.enabled.includes("rtc");
    if (hasRtc) this._initSignalingClient();
    // Defer RTC start until relay is ready so offer connect timer doesn't burn before delivery.
    if (hasRtc) {
      if (this._canSignal()) {
        this._startSecondaryAdapters();
      } else {
        termLog("switch", "rtc deferred — waiting for signaling relay");
        clearTimeout(this._rtcDeferTimer);
        this._rtcDeferTimer = setTimeout(() => {
          if (this._sigDestroyed || this._adapters.has("rtc")) return;
          termLog("switch", "rtc defer expired → start anyway");
          this._startSecondaryAdapters();
        }, RTC_DEFER_MAX_MS);
      }
    }
    this._startWsFallback();
    debugLog("transport", "[pm] connect: RTC + WS parallel (RTC preferred, WS warm standby).");
    termLog("switch", "connect: RTC + WS parallel");
  }

  async _startWsFallback() {
    if (this._adapters.has("ws") || this._sigDestroyed || this._adapters.get("rtc")?.isLoopback) return;
    termLog("switch", "ws-fallback: start (refresh url)");
    // Re-fetch latest tunnelUrl from Worker in case cloudflared restarted.
    await this._refreshTunnelUrl();
    if (this._adapters.has("ws") || this._sigDestroyed || this._adapters.get("rtc")?.isLoopback) {
      termLog("switch", "ws-fallback: aborted (destroyed, loopback or already attached)");
      return;
    }
    termLog("switch", "ws-fallback: connecting");
    this._instantiate("ws");
    this._adapters.get("ws")?.connect(this._buildCtx("ws"));
  }

  async _refreshTunnelUrl() {
    return refreshTunnelUrl(this);
  }

  _initSignalingClient() {
    initSignalingClient(this);
  }

  _instantiate(id) {
    if (this._adapters.has(id)) return;
    const Adapter = getProtocol(id);
    if (!Adapter) return;
    const inst = new Adapter();
    inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
    inst.on("message", ({ event, data, source }) => this._dispatch(event, data, source));
    inst.on("binary", (msg) => this._onBinary(msg));
    if (id === "rtc") {
      inst.on("netFingerprint", (ip) => this._onNetFingerprint(ip));
      if (this._srvCaps) inst.setPeerCaps?.(this._srvCaps);
    }
    this._adapters.set(id, inst);
  }

  // Records fingerprint for telemetry; does not reset restart budget on IP flip-flop.
  _onNetFingerprint(ip) {
    if (!ip || ip === this._netFingerprint) return;
    const prev = this._netFingerprint;
    this._netFingerprint = ip;
    if (!prev) return;
    debugLog("transport", `[pm] net fingerprint ${prev}→${ip} (same network — no backoff reset)`);
  }

  // Re-arm RTC only if STUN probe detects a changed public IP.
  _maybeRearmRtc() {
    if (!this._rtcGivenUp) return;
    const now = Date.now();
    if (now - this._lastStunProbeAt < STUN_PROBE.minIntervalMs) return;
    this._lastStunProbeAt = now;
    probePublicIp().then((raw) => {
      if (this._sigDestroyed) return;
      if (!this._rtcGivenUp) return;
      const ip = raw || (this._giveUpIp === NO_PUBLIC_IP ? NO_PUBLIC_IP : null);
      if (!shouldRearmOnIpChange(this._giveUpIp, ip)) {
        termLog("switch", `rearm check: ip=${ip || "unknown"} same as give-up → stay WS-only`);
        return;
      }
      termLog("switch", `rearm check: ip ${this._giveUpIp || "unknown"}→${ip} changed → re-arm RTC`);
      debugLog("transport", `[pm] public ip changed → re-arm rtc`);
      this._rtcGivenUp = false;
      this._giveUpIp = null;
      this._probeAttempts = 0;
      this._rtcRestartAttempts = 0;
      this._netFingerprint = raw;
      if (!this._canSignal()) { this._sig?.retryNow("stun-rearm"); return; }
      if (this._shouldRenegotiate()) this._restartRtc("stun-rearm");
    }).catch(() => {});
  }

  _startSecondaryAdapters() {
    debugLog("transport", `[pm] startSecondary enabled=${this._profile.enabled}`);
    debugLog("transport", `[pm] startSecondary rtcTestDisabled=${!!this._rtcTestDisabled}`);
    for (const id of this._profile.enabled) {
      if (id === "ws") continue;
      if (id === "rtc" && this._rtcTestDisabled) continue;
      if (this._adapters.has(id)) continue;
      debugLog("transport", `[pm] start adapter ${id}`);
      this._instantiate(id);
      this._adapters.get(id)?.connect(this._buildCtx(id));
    }
  }

  // Stop renegotiating and surface approval UI when host refuses connection.
  _handleApprovalSignal(msg) {
    return handleApprovalSignal(this, msg);
  }

  _onSignalingReady() {
    onSignalingReady(this);
  }

  _canSignal() {
    return !!this._sig?.ready;
  }

  _shouldRenegotiate() {
    return !this._awaitingApproval && this._canSignal();
  }

  _restartRtc(reason = "?") {
    termLog("switch", `restartRtc CALLED by=${reason} attempts=${this._rtcRestartAttempts}`);
    const rtc = this._adapters.get("rtc");
    const action = restartRtcAction({
      testDisabled: !!this._rtcTestDisabled,
      givenUp: this._rtcGivenUp,
      rtcState: rtc?.state,
      hasRtc: !!rtc
    });
    if (action === "skip-test-disabled") { termLog("switch", "restartRtc skipped (rtcTestDisabled)"); return; }
    if (action === "skip-given-up") { termLog("switch", "restartRtc skipped (hard NAT → WS-only)"); return; }
    if (action === "skip-in-flight") { termLog("switch", `restartRtc skipped (rtc=${rtc.state})`); return; }
    if (action === "start-fresh") { termLog("switch", "restartRtc: no rtc → startSecondary"); this._startSecondaryAdapters(); return; }
    termLog("switch", "restartRtc: tear down + renegotiate");
    debugLog("transport", "[pm] ws reconnected → restart rtc");
    try { rtc.disconnect(`restart:${reason}`); } catch {}
    this._adapters.delete("rtc");
    this._rtcSignalingHandler = null;
    this._startSecondaryAdapters();
  }

  // Bypass open/connecting guard when resume probe confirms DC is dead.
  _forceRestartRtc(reason = "?") {
    termLog("switch", `forceRestartRtc CALLED by=${reason}`);
    const rtc = this._adapters.get("rtc");
    if (rtc) {
      try { rtc.disconnect(`force:${reason}`); } catch {}
      this._adapters.delete("rtc");
      this._rtcSignalingHandler = null;
    }
    if (this._rtcGivenUp) {
      termLog("switch", "forceRestartRtc: torn down, no renegotiate (hard NAT)");
      return;
    }
    this._startSecondaryAdapters();
  }

  disconnect() {
    this._watchers?.detach();
    this._watchers = null;
    clearTimeout(this._resumeProbeTimer);
    this._resumeProbeTimer = null;
    clearTimeout(this._rtcDeferTimer);
    this._rtcDeferTimer = null;
    this._probeToken++;
    try { this._sig?.disconnect(); } catch {}
    this._sig = null;
    this._sigDestroyed = true;
    this._sigBuffer = [];
    clearTimeout(this._wsFallbackTimer);
    clearTimeout(this._rejoinDebounceTimer);
    this._rejoinDebounceTimer = null;
    for (const inst of this._adapters.values()) {
      try { inst.disconnect("pm-disconnect"); } catch {}
    }
    this._adapters.clear();
    this._bus.clear();
    this._buffer = [];
    this._connected = false;
    this._rawSocket = null;
    this._disarmRestart();
    termLog("switch", `RESET attempts (was ${this._rtcRestartAttempts}) reason=pm-disconnect`);
    this._rtcRestartAttempts = 0;
    this._probeAttempts = 0;
    this._rtcGivenUp = false;
    this._giveUpIp = null;
    this._lastStunProbeAt = 0;
    for (const t of this._ackTimers.values()) clearTimeout(t);
    this._ackTimers.clear();
  }

  _buildCtx(adapterId, _inst) {
    const ctx = {
      auth: this._auth,
      profile: this._profile
    };
    if (adapterId === "ws") {
      ctx.onRetryStatus = this._wsCallbacks.onRetryStatus;
      ctx.onUrlUpdate = (upd) => {
        if (upd.tunnelUrl) this._auth.tunnelUrl = upd.tunnelUrl;
        if (upd.localIp !== undefined) this._auth.localIp = upd.localIp;
        this._wsCallbacks.onUrlUpdate?.(upd);
      };
    }
    if (adapterId === "rtc") {
      ctx.signaling = {
        send: (msg) => this._sendSignaling(msg),
        on: (handler) => { this._rtcSignalingHandler = handler; },
        off: () => { this._rtcSignalingHandler = null; }
      };
    }
    return ctx;
  }

  _onAdapterStateChange(adapterId, state) {
    debugLog("transport", `[pm] ${adapterId} state=${state}`);
    if (!(adapterId === "rtc" && state === ADAPTER_STATE.closed)) {
      termLog("switch", `${adapterId}→${state}`);
    }

    if (adapterId === "ws") handleWsStateChange(this, state);
    if (adapterId === "rtc") handleRtcStateChange(this, state);

    if (adapterId === "rtc" && state === ADAPTER_STATE.open) {
      debugLog("auth", "[seal] rtc OPEN → sending proof");
      maybeSendTailProof(this);
    }

    this._recomputeType();
    // Track global connection state across carriers regardless of failure order.
    const ready = this._anyAdapterReady();
    if (ready !== this._connected) {
      this._connected = ready;
      if (!ready) {
        this._onConnectFired = false;
        termLog("switch", `onDisconnect FIRE (last carrier gone: ${adapterId}→${state})`);
        this._wsCallbacks.onDisconnect?.(`${adapterId}-${state}`);
      }
    }
    this._flushBuffer();
  }

  // Debounce rejoin on carrier reconnect to allow pending RTC connection to settle first.
  _maybeFireRejoin(adapterId, reason) {
    const other = adapterId === "ws" ? this._adapters.get("rtc") : this._adapters.get("ws");
    if (other?.ready) {
      debugLog("transport", `[pm] ${reason} → skip rejoin (other ready)`);
      termLog("switch", `${reason} → skip rejoin (other ready)`);
      return;
    }
    if (adapterId === "ws" && other && other.state === ADAPTER_STATE.connecting) {
      debugLog("transport", `[pm] ${reason} → debounce rejoin (rtc connecting)`);
      termLog("switch", `${reason} → debounce rejoin ${REJOIN_DEBOUNCE_MS}ms (rtc connecting)`);
      clearTimeout(this._rejoinDebounceTimer);
      this._rejoinDebounceTimer = setTimeout(() => {
        this._rejoinDebounceTimer = null;
        const r = this._adapters.get("rtc");
        if (r?.ready) {
          termLog("switch", "debounce: rtc opened → skip rejoin");
          return;
        }
        termLog("switch", `debounce expired → FIRE rejoin (rtc=${r?.state || "absent"})`);
        this._bus.dispatch("connect", []);
      }, REJOIN_DEBOUNCE_MS);
      return;
    }
    termLog("switch", `${reason} → FIRE rejoin`);
    this._bus.dispatch("connect", []);
  }

  _recomputeType() {
    const adapter = this._pickAdapter(CHANNELS.binary) || this._pickAdapter(CHANNELS.control);
    const next = !adapter ? "ws"
      : adapter.constructor.id === "rtc" ? (adapter.typeDetail || "dc-stun")
      : "ws";
    if (next !== this._type) {
      this._type = next;
      this._rtcCallbacks.onTransportChange?.(next);
    }
  }

  _anyAdapterReady() {
    for (const a of this._adapters.values()) if (a.ready) return true;
    return false;
  }

  _pickAdapter(channel) {
    return pickAdapter(this._adapters, this._profile, channel);
  }

  _sendControl(event, args) {
    sendControl(this, event, args);
  }

  _flushBuffer() {
    flushBuffer(this);
  }

  _dispatch(event, payload, source) {
    dispatch(this, event, payload, source);
  }

  _onBinary(msg) {
    onBinary(this, msg);
  }

  _scheduleAckTimeout(ackId) {
    scheduleAckTimeout(this, ackId);
  }

  // Two-phase RTC recovery: fast initial backoff followed by periodic background probe.
  _armRestart(fn, delay) {
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartDueAt = Date.now() + delay;
    this._rtcRestartTimer = setTimeout(fn, delay);
  }

  _disarmRestart() {
    const left = this._rtcRestartTimer ? Math.max(this._rtcRestartDueAt - Date.now(), 0) : -1;
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = null;
    this._rtcRestartDueAt = 0;
    return left;
  }

  _scheduleRtcRestart(reason = "?") {
    termLog("switch", `rtcRestart REQ by=${reason} attempts=${this._rtcRestartAttempts} probe=${this._probeAttempts} givenUp=${this._rtcGivenUp} pending=${!!this._rtcRestartTimer}`);
    // Deduplicate concurrent triggers while a restart rung is already armed.
    if (this._rtcRestartTimer) {
      const inMs = Math.max(this._rtcRestartDueAt - Date.now(), 0);
      termLog("switch", `rtcRestart SKIP by=${reason} (pending rung ${this._rtcRestartAttempts} fires in ${inMs}ms)`);
      return;
    }
    if (this._rtcGivenUp) {
      termLog("switch", "scheduleRtcRestart skipped (hard NAT → WS-only)");
      debugLog("transport", "[pm] rtc probe skipped (given up — hard NAT)");
      return;
    }
    const step = nextRestartStep({
      attempts: this._rtcRestartAttempts,
      probeAttempts: this._probeAttempts,
      verdict: () => this._adapters.get("rtc")?.natVerdict?.() ?? "unknown"
    });
    if (step.verdict !== undefined) {
      termLog("switch", `scheduleRtcRestart natVerdict=${step.verdict} probeAttempts=${step.probeAttempts}`);
      debugLog("transport", `[pm] rtc nat verdict=${step.verdict} after ${step.probeAttempts} probes`);
    }
    if (step.giveUp) {
      this._probeAttempts = step.probeAttempts;
      this._rtcGivenUp = true;
      this._giveUpIp = this._netFingerprint;
      if (!this._giveUpIp) {
        probePublicIp().then((ip) => {
          if (this._rtcGivenUp && !this._giveUpIp) {
            this._giveUpIp = ip || NO_PUBLIC_IP;
            termLog("switch", `give-up baseline from probe: ip=${this._giveUpIp}`);
          }
        }).catch(() => {});
      }
      termLog("switch", `RTC give-up: hard NAT → WS-only (ip=${this._giveUpIp || "pending"})`);
      return;
    }
    const { delay, isProbe } = step;
    this._probeAttempts = step.probeAttempts;
    this._rtcRestartAttempts = step.attempts;
    termLog("switch", `rtcRestart ARM by=${reason} rung=${this._rtcRestartAttempts} delay=${delay}ms probe=${isProbe}`);
    debugLog("transport", `[pm] schedule rtc ${isProbe ? "probe" : "restart"} #${this._rtcRestartAttempts} in ${delay}ms`);
    const retry = () => {
      this._disarmRestart();
      if (this._awaitingApproval) return;
      if (!this._sig?.ready) return;
      // Avoid tearing down peer before ICE negotiation timeout has elapsed.
      const rtc = this._adapters.get("rtc");
      if (rtc) {
        const action = restartTimerAction({
          state: rtc.state,
          connectingSince: rtc.connectingSince,
          connectDeadline: rtc.connectDeadline,
          now: Date.now(),
          connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
        });
        if (action === "wait") {
          // Re-arm at same rung until peer's ICE deadline without counting as an attempt.
          const until = Math.max(peerDeadline({
            connectingSince: rtc.connectingSince,
            connectDeadline: rtc.connectDeadline,
            connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
          }) - Date.now(), delay);
          termLog("switch", `restart tick: peer still young (rung ${this._rtcRestartAttempts}) → re-arm in ${until}ms, no rung spent`);
          this._armRestart(retry, until);
          return;
        }
        if (action === "teardown") {
          try { rtc.disconnect(`rung-${this._rtcRestartAttempts}-teardown`); } catch {}
          this._adapters.delete("rtc");
          this._rtcSignalingHandler = null;
        }
      }
      this._restartRtc(`rung-${this._rtcRestartAttempts}`);
    };
    this._armRestart(retry, delay);
  }

  _sendSignaling(msg) {
    sendSignaling(this, msg);
  }

  _flushSigBuffer() {
    flushSigBuffer(this);
  }
}
