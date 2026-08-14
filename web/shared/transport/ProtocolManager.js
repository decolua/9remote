import { WsProtocol } from "./WsProtocol";
import { WebRtcProtocol } from "./WebRtcProtocol";
import { registerProtocol, getProtocol } from "./registry";
import { CHANNELS, ADAPTER_STATE, REJOIN_DEBOUNCE_MS, RTC_CONNECT_TIMEOUT_MS, STUN_PROBE } from "@/shared/constants/transport";
import { probePublicIp, shouldRearmOnIpChange, NO_PUBLIC_IP } from "./stunProbe";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { createProxySocket, fireProxyEvent } from "./lib/proxySocket";
import { callerTrace, pickAdapter } from "./lib/controlRouting";
import { nextRestartStep, restartTimerAction, restartRtcAction } from "./lib/rtcRecoveryPolicy";
import { attachWatchers } from "./lib/pmWatchers";
import { handleWsStateChange, handleRtcStateChange } from "./lib/adapterStateHandlers";
import { buildConfig, initialState } from "./lib/pmConfig";
import { initSignalingClient, handleApprovalSignal, onSignalingReady, sendSignaling, flushSigBuffer, refreshTunnelUrl } from "./lib/pmSignaling";
import { sendControl, flushBuffer, dispatch, onBinary, scheduleAckTimeout } from "./lib/pmMessaging";

// Auto-register built-in adapters
registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

/**
 * ProtocolManager — orchestrator. Holds auth, instantiates adapters from profile,
 * routes messages by channel via priority, auto-reroutes on stateChange.
 *
 * Backward-compat API kept (on/off/emit/connect/disconnect, socketRef, type, connected, connectionMode).
 */
export class ProtocolManager {
  constructor(wsConfig, rtcConfig) {
    // Map legacy config → unified shape
    const { profile, auth, wsCallbacks, rtcCallbacks, peerId } = buildConfig(wsConfig, rtcConfig);
    this._profile = profile;
    this._auth = auth;
    this._wsCallbacks = wsCallbacks;
    this._rtcCallbacks = rtcCallbacks;
    this._peerId = peerId;
    Object.assign(this, initialState());

    // Persistent proxy socket — emit always routed through PM (auto fallback to RTC).
    // on/off delegate to current raw socket. Survives WS disconnect.
    this._proxySocket = createProxySocket(this);
    this.socketRef = { current: this._proxySocket };
    // Environment watchers (tab visibility/resume/freeze, network handover) drive the
    // RTC recovery paths — see lib/pmWatchers.
    this._watchers = attachWatchers(this);
  }

  get type() { return this._type; }
  get connected() { return this._connected; }
  get connectionMode() { return this._connectionMode; }
  get wsBlocked() { return this._adapters.get("ws")?.blocked || false; }

  /** Dev/test: block WS reconnect to verify RTC standalone behavior. */
  setWsBlocked(blocked) {
    this._adapters.get("ws")?.setBlocked(blocked);
  }

  /** Widen WS retry window while agent self-updates. */
  setUpdating(updating) {
    this._adapters.get("ws")?.setUpdating(updating);
  }

  /** User-triggered immediate reconnect — skips backoff and revives a failed adapter. */
  retryNow() {
    const ws = this._adapters.get("ws");
    if (ws) { ws.retryNow?.(); return; }
    // Adapter was torn down (PM.disconnect) — rebuild from scratch
    this.connect();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /** Legacy emit — routes through control channel via best adapter. */
  emit(event, ...args) {
    this._sendControl(event, args);
  }

  /**
   * Send a binary payload on a channel (file transfer). Picks the best adapter
   * (RTC preferred), falls back to WS on RTC backpressure/death — same pattern
   * as _sendControl. Returns true if delivered on any adapter.
   */
  sendBinary(channel, payload) {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
  }

  connect() {
    // RTC + WS in parallel: RTC is the preferred carrier (P2P, low latency); the
    // WS tunnel stays warm as an instant-switch standby. Data routing still prefers
    // RTC via _pickAdapter, so WS is near-idle when RTC is healthy — but always
    // ready, making a carrier switch 0ms (no spawn-on-failure delay → no flicker).
    this._sigDestroyed = false;
    this._initSignalingClient();
    this._startSecondaryAdapters();
    this._startWsFallback();
    debugLog("transport", "[pm] connect: RTC + WS parallel (RTC preferred, WS warm standby).");
    termLog("switch", "connect: RTC + WS parallel");
  }

  // Bring up the WS tunnel adapter (parallel standby or fallback after RTC death).
  async _startWsFallback() {
    if (this._adapters.has("ws") || this._sigDestroyed) return;
    termLog("switch", "ws-fallback: start (refresh url)");
    // The cached tunnelUrl may be stale (cloudflared restarted → new trycloudflare
    // URL). Re-fetch the latest from the Worker before connecting.
    await this._refreshTunnelUrl();
    // Re-check after await: disconnect() may have run, or a concurrent call may
    // have already attached ws while the fetch was in flight.
    if (this._adapters.has("ws") || this._sigDestroyed) {
      termLog("switch", "ws-fallback: aborted (destroyed or already attached)");
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
    if (id === "rtc") inst.on("netFingerprint", (ip) => this._onNetFingerprint(ip));
    this._adapters.set(id, inst);
  }

  /** STUN reported a different public egress IP. We do NOT reset the restart
   * budget here anymore: dual-stack ISPs and carrier NAT pools make the IP
   * flip-flop between IPv4/IPv6 and neighbours of the SAME network, which fired
   * a false "network changed" on every restart and pinned RTC to the shortest
   * backoff forever. A real network handover is detected via the browser's
   * online/connection events (and resets the budget there); RTC OPEN itself
   * also resets. This handler now only records the fingerprint for telemetry. */
  _onNetFingerprint(ip) {
    if (!ip || ip === this._netFingerprint) return;
    const prev = this._netFingerprint;
    this._netFingerprint = ip;
    if (!prev) return; // first gather of the session — nothing changed yet
    debugLog("transport", `[pm] net fingerprint ${prev}→${ip} (same network — no backoff reset)`);
  }

  /** Lift an RTC give-up only on evidence: a STUN probe (public STUN, no DO call,
   *  no agent) reporting a public IP different from the one we gave up on. Same
   *  IP → the NAT that refused P2P is still there, so stay WS-only and spend
   *  nothing. Rate-limited: resume/visibility can fire in bursts. */
  _maybeRearmRtc() {
    if (!this._rtcGivenUp) return;
    const now = Date.now();
    if (now - this._lastStunProbeAt < STUN_PROBE.minIntervalMs) return;
    this._lastStunProbeAt = now;
    probePublicIp().then((raw) => {
      // The probe takes seconds — the PM may have been torn down meanwhile.
      // Resurrecting RTC on a disconnected PM would leak a peer nobody owns.
      if (this._sigDestroyed) return;
      if (!this._rtcGivenUp) return; // something else already re-armed us
      // Compare like for like: a STUN-blocked network reports NO_PUBLIC_IP on both
      // sides, so it reads as "unchanged" instead of re-arming on every resume.
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
      // Relay may be down (we skipped its retry while WS-only) — kick it and let
      // _onSignalingReady fire the restart once a signaling path exists again.
      if (!this._canSignal()) { this._sig?.retryNow(); return; }
      if (this._shouldRenegotiate()) this._restartRtc();
    }).catch(() => {});
  }

  _startSecondaryAdapters() {
    debugLog("transport", `[pm] startSecondary enabled=${this._profile.enabled}`);
    debugLog("transport", `[pm] startSecondary rtcTestDisabled=${!!this._rtcTestDisabled}`);
    for (const id of this._profile.enabled) {
      if (id === "ws") continue;
      if (id === "rtc" && this._rtcTestDisabled) continue; // agent test-toggle
      if (this._adapters.has(id)) continue;
      debugLog("transport", `[pm] start adapter ${id}`);
      this._instantiate(id);
      this._adapters.get(id)?.connect(this._buildCtx(id));
    }
  }

  /** The agent answered "not approved" rather than failing to connect. Surface it
   * as approval UI and stop renegotiating — retrying can't change a policy answer,
   * and letting it reach the RTC adapter would tear the peer down and fall back to
   * the tunnel, hiding the approval screen behind a connection error.
   * @returns {boolean} true when handled (caller must not forward the message) */
  _handleApprovalSignal(msg) {
    return handleApprovalSignal(this, msg);
  }

  /** Relay (re)connected — drain queued signaling, and renegotiate if RTC died
   * while we had no carrier (resume from background, network handover). */
  _onSignalingReady() {
    onSignalingReady(this);
  }

  /** Can a fresh offer/answer reach the agent? DO is the sole signaling carrier. */
  _canSignal() {
    return !!this._sig?.ready;
  }

  /** Waiting on the host to approve this device — a new offer would just be
   * refused again, so recovery paths stand down until approval arrives. */
  _shouldRenegotiate() {
    return !this._awaitingApproval && this._canSignal();
  }

  /** Tear down RTC + renegotiate via new WS socket (called on WS reconnect). */
  _restartRtc() {
    // TEMP DIAGNOSTIC
    termLog("switch", `restartRtc CALLED by=${callerTrace()} attempts=${this._rtcRestartAttempts}`);
    const rtc = this._adapters.get("rtc");
    // Guards: agent test-toggle, hard-NAT give-up (every recovery path must stand
    // down or the give-up only stops the probe timer), and a peer another path
    // already spun up (don't kill it mid-handshake).
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
    try { rtc.disconnect(); } catch {}
    this._adapters.delete("rtc");
    this._rtcSignalingHandler = null;
    this._startSecondaryAdapters();
  }

  /** Force restart bypassing the open/connecting guard — used when the resume
   * probe confirms the DC is dead despite rtc.state reporting "open". */
  _forceRestartRtc() {
    termLog("switch", `forceRestartRtc CALLED by=${callerTrace()}`);
    const rtc = this._adapters.get("rtc");
    if (rtc) {
      try { rtc.disconnect(); } catch {}
      this._adapters.delete("rtc");
      this._rtcSignalingHandler = null;
    }
    // Hard NAT → tear the dead peer down but don't negotiate a new one; that
    // would spend a DO round-trip the same NAT will refuse again.
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
    this._probeToken++; // invalidate any in-flight getStats probe
    try { this._sig?.disconnect(); } catch {}
    this._sig = null;
    this._sigDestroyed = true;
    this._sigBuffer = [];
    clearTimeout(this._wsFallbackTimer);
    clearTimeout(this._rejoinDebounceTimer);
    this._rejoinDebounceTimer = null;
    for (const inst of this._adapters.values()) {
      try { inst.disconnect(); } catch {}
    }
    this._adapters.clear();
    this._listeners.clear();
    this._buffer = [];
    this._connected = false;
    this._rawSocket = null;
    // Clear RTC zombie recovery state
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = null;
    termLog("switch", `RESET attempts (was ${this._rtcRestartAttempts}) reason=pm-disconnect`); // TEMP DIAGNOSTIC
    this._rtcRestartAttempts = 0;
    this._probeAttempts = 0;
    this._rtcGivenUp = false;
    this._giveUpIp = null;
    this._lastStunProbeAt = 0;
    for (const t of this._ackTimers.values()) clearTimeout(t);
    this._ackTimers.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

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
    // The adapter already logs its own transition with a reason — repeating it
    // here doubles every line, so only log states adapters don't announce.
    if (!(adapterId === "rtc" && state === ADAPTER_STATE.closed)) {
      termLog("switch", `${adapterId}→${state}`);
    }

    if (adapterId === "ws") handleWsStateChange(this, state);
    if (adapterId === "rtc") handleRtcStateChange(this, state);

    this._recomputeType();
    this._connected = this._anyAdapterReady();
    this._flushBuffer();
  }

  /** Fire the proxy "connect" rejoin on a carrier reconnect — UNLESS the other
   * carrier is already carrying data, in which case this is a transparent switch
   * and terminal panes must not reset+reload. Only the first adapter up after a
   * full outage triggers the rejoin.
   *
   * Debounce: if WS reconnects while RTC is still connecting (typical after resume
   * — WS via tunnel is faster than RTC ICE gather), wait briefly for RTC. If RTC
   * opens, the switch is transparent (skip rejoin, no flicker). If RTC fails, the
   * debounce fires the rejoin so content recovers via WS. */
  _maybeFireRejoin(adapterId, reason) {
    const other = adapterId === "ws" ? this._adapters.get("rtc") : this._adapters.get("ws");
    if (other?.ready) {
      debugLog("transport", `[pm] ${reason} → skip rejoin (other ready)`);
      termLog("switch", `${reason} → skip rejoin (other ready)`);
      return;
    }
    // WS just reconnected but RTC is mid-handshake — debounce instead of resetting
    // the terminal; RTC usually opens within ~500ms and the switch stays invisible.
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
        fireProxyEvent(this._proxySocket, "connect");
      }, REJOIN_DEBOUNCE_MS);
      return;
    }
    termLog("switch", `${reason} → FIRE rejoin`);
    fireProxyEvent(this._proxySocket, "connect");
  }

  _recomputeType() {
    // type follows binary channel preference (legacy behavior)
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

  /**
   * Send control event with multi-arg + optional callback (last fn arg = ack).
   * WS adapter uses socket.io native multi-arg/ack; RTC uses {event, args, ackId} envelope.
   */
  _sendControl(event, args) {
    sendControl(this, event, args);
  }

  _flushBuffer() {
    flushBuffer(this);
  }

  /**
   * Dispatch incoming message. RTC payloads carry {args} array; WS payloads carry {data}
   * (legacy single-arg from raw socket.io onAny).
   */
  _dispatch(event, payload, source) {
    dispatch(this, event, payload, source);
  }

  /**
   * Incoming binary frame from an adapter's "binary" event (RTC DC "file").
   * Route to socket.io-style "file-bin" listeners so WS and RTC paths share one
   * handler (WS delivers "file-bin" natively via socket.io onAny).
   */
  _onBinary(msg) {
    onBinary(this, msg);
  }

  // ─── RTC zombie recovery ───────────────────────────────────────────────────

  // Short ack timeout — if ack doesn't arrive, RTC is likely zombie (open but bytes lost).
  _scheduleAckTimeout(ackId) {
    scheduleAckTimeout(this, ackId);
  }

  // Two-phase RTC recovery: fast backoff (1s/2s/4s) right after failure, then a
  // slow probe (30s) that keeps trying P2P while the tunnel carries data. Never
  // gives up — network conditions improve, and a cheap STUN probe every 30s is
  // negligible next to tunnel bandwidth. Reset-on-open and net-change restore the
  // fast phase. DO-down skips the probe (_onSignalingReady restarts when it's back).
  _scheduleRtcRestart() {
    // TEMP DIAGNOSTIC — value before ++ reveals if a reset happened between cycles
    termLog("switch", `scheduleRtcRestart ENTER attempts=${this._rtcRestartAttempts} probeAttempts=${this._probeAttempts} givenUp=${this._rtcGivenUp}`);
    // Hard NAT (symmetric / STUN-blocked, no TURN) → P2P can't succeed, stop
    // spending DO signaling calls. Re-armed by network change / visibility resume.
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
      // Keep the counter the failed probe advanced — every re-arm path resets it,
      // but leaving it stale would misreport the ladder position in diagnostics.
      this._probeAttempts = step.probeAttempts;
      this._rtcGivenUp = true;
      // Remember the network we gave up on — a resume only re-arms RTC when
      // the public IP differs (evidence of a real handover, not a timer).
      this._giveUpIp = this._netFingerprint;
      if (!this._giveUpIp) {
        // The peer gathered no srflx (UDP blocked), so we have no baseline.
        // Take one from the standalone probe — the same source the resume check
        // uses — else every resume would compare against null, read it as
        // "changed", and re-enter the ladder forever. A probe that also finds no
        // public IP records NO_PUBLIC_IP so the baseline stays stable.
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
    // TEMP DIAGNOSTIC
    termLog("switch", `scheduleRtcRestart by=${callerTrace()} attempt=${this._rtcRestartAttempts} delay=${delay}ms probe=${isProbe}`);
    debugLog("transport", `[pm] schedule rtc ${isProbe ? "probe" : "restart"} #${this._rtcRestartAttempts} in ${delay}ms`);
    clearTimeout(this._rtcRestartTimer);
    this._rtcRestartTimer = setTimeout(() => {
      this._rtcRestartTimer = null;
      if (this._awaitingApproval) return;
      if (!this._sig?.ready) return; // DO down — _onSignalingReady will restart
      // Only tear down a peer past its natural connect timeout. A younger peer
      // is still doing ICE — killing it on the first 500ms tick restarted the
      // loop forever. Let the adapter's own _connectTimer close it (→ the closed
      // branch restarts) and just reschedule.
      const rtc = this._adapters.get("rtc");
      if (rtc) {
        const action = restartTimerAction({
          state: rtc.state,
          connectingSince: rtc.connectingSince,
          now: Date.now(),
          connectTimeoutMs: RTC_CONNECT_TIMEOUT_MS
        });
        if (action === "wait") {
          this._scheduleRtcRestart(); // peer still young → try again later
          return;
        }
        if (action === "teardown") {
          try { rtc.disconnect(); } catch {}
          this._adapters.delete("rtc");
          this._rtcSignalingHandler = null;
        }
      }
      this._restartRtc();
    }, delay);
  }

  // ─── Signaling routing (cross-adapter for RTC) ────────────────────────────

  _sendSignaling(msg) {
    sendSignaling(this, msg);
  }

  _flushSigBuffer() {
    flushSigBuffer(this);
  }
}
