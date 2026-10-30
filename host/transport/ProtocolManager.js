import { WsProtocol } from "./WsProtocol.js";
import { WebRtcProtocol } from "./WebRtcProtocol.js";
import { registerProtocol, getProtocol } from "./registry.js";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, RTC_DEAD_GRACE_MS, SIGNALING_ERRORS, SEQ_CTL } from "../lib/transportConstants.js";
import { createOutboundLog, createIntake, newEpoch, STREAM_EVENTS } from "./seqStream.js";
import { AUTH_EVENTS } from "../lib/connectionConstants.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";
import { isDeviceRejected } from "../lib/deviceApproval.js";
import { onSignalingMessage, onSignalingReady, sendSignaling as sendGlobalSignaling, isSignalingReady } from "../lib/signalingGlobal.js";
import { pushTransportState } from "../api/ui.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("transport");

registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

/** Server ProtocolManager — per-client orchestrator. */
export class ProtocolManager {
  constructor(socket, config) {
    const profileId = config.enableWebRTC ? "remoteDesktop" : "clientApp";
    const profile = { ...TRANSPORT_PROFILES[profileId] };
    if (!config.enableWebRTC) profile.enabled = ["ws"];

    profile.rtc = {
      enableTurn: Boolean(config.enableTurn),
      turnApiUrl: config.turnApiUrl || null,
      turnRefreshInterval: config.turnRefreshInterval,
      dcMaxMessageSize: config.dcMaxMessageSize,
      answerTimeout: config.answerTimeout
    };

    this._profile = profile;
    this._auth = { apiKey: config.apiKey || null, socketId: socket?.id || null };
    this._socket = socket || null;
    this._host = socket || null;
    this._wsChunkSize = config.wsChunkSize;
    this._dcChunkSize = config.dcChunkSize;
    this._dcMaxTilesPerFrame = config.dcMaxTilesPerFrame;
    this._maxControlBuffer = config.maxControlBuffer;
    this._deviceId = config.signaling?.deviceId || null;
    this._approvalDeviceId = this._deviceId ? this._deviceId.split(":")[0] : null;
    this._sigBuffer = [];

    this._adapters = new Map();
    this._binOut = false;
    this._stats = { binChunks: 0, b64Chunks: 0, sentRtc: 0, sentWs: 0, binAnnounced: false, env2Announced: false };
    this._statsTimer = setInterval(() => this._reportStats(), 60_000);
    this._statsTimer.unref?.();
    this._rtcSignalingHandler = null;
    this._wsPendingSince = new Map();
    this._rtcPendingSince = new Map();

    // Sequenced control stream: outbound replay ring + one-door inbound sequencer.
    this._peerSeqCtl = false;
    this._seqEpoch = newEpoch();
    this._outLog = createOutboundLog({ maxBytes: SEQ_CTL.ringMaxBytes, maxEntries: SEQ_CTL.maxEntries });
    this._seqStats = { dupes: 0, replayed: 0, gaps: 0 };
    this._intakeSeq = createIntake({
      holdMax: SEQ_CTL.holdMax,
      gapDeadlineMs: SEQ_CTL.gapDeadlineMs,
      deliver: (env) => this._deliver(env),
      requestGap: (from, to) => this._sendStreamEvent(STREAM_EVENTS.GAP, { from, to }),
      onLoss: (from, to) => {
        this._seqStats.gaps++;
        logger.warn(`[seq] skip lost ${from}..${to} peer=${this._deviceId?.slice(0, 12) || "?"}`);
      },
      onDupe: () => { this._seqStats.dupes++; }
    });
  }

  get type() {
    const adapter = this._pickAdapter(CHANNELS.binary);
    return adapter?.constructor.id === "rtc" ? "dc" : "ws";
  }

  async init() {
    for (const id of this._profile.enabled) {
      if (id === "ws" && this._host?.defersWsAdapter) continue;
      const Adapter = getProtocol(id);
      if (!Adapter) continue;
      let inst;
      try {
        inst = new Adapter();
        inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
        inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source, args));
        inst.on("binary", (msg) => this._onBinary(msg));
        await inst.connect(this._buildCtx(id));
      } catch (err) {
        if (id === "rtc") {
          console.warn(`[ProtocolManager] WebRTC unavailable — remote desktop over WS only. (${err.message})`);
          continue;
        }
        throw err;
      }
      this._adapters.set(id, inst);
    }
    this.setupSignaling(this._socket);
  }

  /** Late-attach a socket.io socket to an RTC-only session. */
  async attachSocket(socket) {
    if (!socket) return;
    const existing = this._adapters.get("ws");
    if (existing) {
      if (existing.socket === socket) return;
      // Evict a stale ws adapter: its socket died undetected (half-open tunnel)
      // and would silently refuse this live socket — events would hit zero listeners.
      this._adapters.delete("ws");
      const staleSocket = existing.socket;
      try { existing.disconnect(); } catch {}
      try { staleSocket?.disconnect?.(true); } catch {}
    }
    if (this._attachingWs) {
      this._attachingWs = this._attachingWs
        .catch(() => {})
        .then(() => this.attachSocket(socket));
      return this._attachingWs;
    }
    this._attachingWs = this._attachSocketInternal(socket)
      .finally(() => { this._attachingWs = null; });
    return this._attachingWs;
  }

  async _attachSocketInternal(socket) {
    this._socket = socket;
    this._auth.socketId = socket.id;
    const Adapter = getProtocol("ws");
    if (!Adapter) return;
    const inst = new Adapter();
    inst.on("stateChange", (state) => this._onAdapterStateChange("ws", state));
    inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source, args));
    inst.on("binary", (msg) => this._onBinary(msg));
    await inst.connect(this._buildCtx("ws"));
    this._adapters.set("ws", inst);
    socket.on("disconnect", () => {
      if (this._adapters.get("ws") !== inst) return;
      this._adapters.delete("ws");
      this._socket = null;
      try { inst.disconnect(); } catch {}
    });
    this._flushBuffer();
  }

  setupSignaling(_socket) {
    if (this._offGlobalSig) return;
    this._offGlobalSig = onSignalingMessage(this._deviceId, (msg) => {
      if (msg.type === "offer") {
        if (this._approvalDeviceId && isDeviceRejected(this._approvalDeviceId)) {
          this._sendSignaling({ type: "error", message: SIGNALING_ERRORS.rejected });
          return;
        }
        if (!this._rtcSignalingHandler) {
          this._sendSignaling({ type: "error", message: "rtc-disabled" });
          return;
        }
      }
      this._rtcSignalingHandler?.(msg);
    });
    this._offGlobalReady = onSignalingReady(() => this._flushSigBuffer());
  }

  emit(event, ...args) {
    this._sendControl(event, args);
  }

  /** Broadcast event across all ready carriers. The sequenced stream already
   *  guarantees delivery (ring replay + peer dedupe), so this is now a plain
   *  send through the one door — the old every-carrier fan-out is exactly what
   *  duplicated output before, and dedupe made it redundant. Returns true: the
   *  stream owns the message even when no carrier is up this instant. */
  emitEverywhere(event, ...args) {
    this._sendControl(event, args);
    return true;
  }

  /** Recreate RTC adapter and signaling handler. */
  restartRtc() {
    if (this._adapters.has("rtc")) return;
    const Adapter = getProtocol("rtc");
    if (!Adapter) return;
    try {
      const inst = new Adapter();
      inst.on("stateChange", (s) => this._onAdapterStateChange("rtc", s));
      inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source, args));
      inst.on("binary", (msg) => this._onBinary(msg));
      if (this._peerCaps) inst.setPeerCaps?.(this._peerCaps);
      this._adapters.set("rtc", inst);
      inst.connect(this._buildCtx("rtc"));
    } catch (e) {
      console.warn(`[ProtocolManager] restartRtc failed: ${e.message}`);
    }
  }

  /** Send binary payload using best ready adapter (RTC preferred). */
  sendBinary(channel, payload) {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
  }

  /** Send screen tiles: prefer RTC binary, fallback to WS chunked. */
  sendTiles(payload, encodeBatch, channel = CHANNELS.binary) {
    const { tiles, timestamp } = payload;
    if (!tiles?.length) return [];

    const adapter = this._pickAdapter(channel);
    const frameTs = timestamp ?? Date.now();

    if (adapter?.constructor.id === "rtc" && encodeBatch) {
      return this._emitTilesRtc(adapter, tiles, frameTs, encodeBatch, channel);
    }
    return this._emitTilesChunked(tiles, frameTs, channel);
  }

  close() {
    this._closed = true;
    clearInterval(this._statsTimer);
    clearTimeout(this._deadTimer);
    this._deadTimer = null;
    try { this._offGlobalSig?.(); } catch {}
    this._offGlobalSig = null;
    try { this._offGlobalReady?.(); } catch {}
    this._offGlobalReady = null;
    this._sigBuffer = [];
    for (const inst of this._adapters.values()) {
      try { inst.disconnect(); } catch {}
    }
    this._adapters.clear();
    this._outLog.clear();
    this._intakeSeq.reset();
  }

  /** Route socket.emit through ProtocolManager control channel. */
  attachAsBus(socket) {
    if (socket._rawEmit) return;
    const rawEmit = socket.emit.bind(socket);
    socket._rawEmit = rawEmit;
    const reserved = new Set(["error", "disconnect", "disconnecting", "connect", "newListener", "removeListener"]);
    socket.emit = (event, ...args) => {
      if (reserved.has(event)) return rawEmit(event, ...args);
      this._sendControl(event, args);
      return true;
    };
  }

  _emitTilesChunked(tiles, frameTs, channel = CHANNELS.binary) {
    const ws = this._adapters.get("ws");
    if (!ws?.ready) return [];
    const size = this._wsChunkSize;
    const pendingSince = this._wsPendingSince;
    const now = frameTs ?? Date.now();
    const ordered = [...tiles].sort((a, b) => {
      const ap = pendingSince.get(a.tileIndex) ?? Infinity;
      const bp = pendingSince.get(b.tileIndex) ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.tileIndex - b.tileIndex;
    });
    const sent = [];
    for (let i = 0; i < ordered.length; i += size) {
      const chunk = ordered.slice(i, i + size);
      if (ws.send(channel, encodeTilesBatch(chunk, frameTs)) === false) {
        for (let j = i; j < ordered.length; j++) {
          const tileIndex = ordered[j].tileIndex;
          if (!pendingSince.has(tileIndex)) pendingSince.set(tileIndex, now);
        }
        break;
      }
      for (const tile of chunk) pendingSince.delete(tile.tileIndex);
      sent.push(...chunk);
    }
    return sent;
  }

  _emitTilesRtc(rtc, tiles, frameTs, encodeBatch, channel = CHANNELS.binary) {
    const max = this._profile.rtc?.dcMaxMessageSize ?? 65536;
    const n = tiles.length;
    const pendingSince = this._rtcPendingSince;
    const now = frameTs ?? Date.now();
    const ordered = [...tiles].sort((a, b) => {
      const ap = pendingSince.get(a.tileIndex) ?? Infinity;
      const bp = pendingSince.get(b.tileIndex) ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.tileIndex - b.tileIndex;
    });
    const chunkTiles = (cs) => ordered.slice(0, cs);
    let chunkSize = Math.min(this._dcChunkSize, n);
    while (chunkSize > 1 && encodeBatch(chunkTiles(chunkSize), frameTs).length > max) {
      chunkSize = Math.floor(chunkSize / 2);
    }
    const ws = this._adapters.get("ws");
    const sent = [];
    for (let i = 0; i < n; i += chunkSize) {
      const chunk = ordered.slice(i, i + chunkSize);
      const buf = encodeBatch(chunk, frameTs);
      if (buf.length > max) {
        if (chunk.length === 1 && ws?.ready && ws.send(channel, buf) !== false) {
          pendingSince.delete(chunk[0].tileIndex);
          sent.push(...chunk);
        }
        continue;
      }
      if (rtc.send(channel, buf) === false) {
        const remaining = ordered.slice(i);
        if (ws?.ready) {
          const wsSent = this._emitTilesChunked(remaining, frameTs, channel);
          for (const t of wsSent) pendingSince.delete(t.tileIndex);
          sent.push(...wsSent);
        } else {
          for (let j = i; j < n; j++) {
            if (!pendingSince.has(ordered[j].tileIndex)) pendingSince.set(ordered[j].tileIndex, now);
          }
        }
        return sent;
      }
      for (const tile of chunk) pendingSince.delete(tile.tileIndex);
      sent.push(...chunk);
    }
    return sent;
  }

  _buildCtx(adapterId) {
    const ctx = { auth: this._auth, profile: this._profile };
    if (adapterId === "ws") {
      ctx.socket = this._socket;
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
    if (this._closed) return;
    logger.debug(`${adapterId}→${state} (carriers: ${[...this._adapters.entries()].map(([id, a]) => `${id}=${a.ready ? "ready" : a.state}`).join(" ")})`);
    pushTransportState();
    // No carrier = freeze gap deadlines; they re-arm (and re-ask) on reconnect.
    this._intakeSeq.setPaused(!this.hasReadyAdapter());
    if (state === ADAPTER_STATE.open) {
      clearTimeout(this._deadTimer);
      this._deadTimer = null;
      this._flushBuffer();
      return;
    }
    // A lane died — replay the unconfirmed window on whatever is left (lane
    // switch). "degraded" (transient ICE blip) must not trigger a full re-send.
    if (state === ADAPTER_STATE.closed) this._flushBuffer();
    if (state === ADAPTER_STATE.closed && adapterId === "rtc"
      && this._host?.defersWsAdapter && !this._adapters.get("ws")?.ready) {
      clearTimeout(this._deadTimer);
      logger.debug(`rtc closed, no ws on a HostBus session → ${RTC_DEAD_GRACE_MS}ms grace before declaring dead`);
      this._deadTimer = setTimeout(() => {
        this._deadTimer = null;
        if (this._closed || this._adapters.get("rtc")?.ready) {
          logger.debug("rtc came back inside grace — session kept");
          return;
        }
        logger.info("rtc never returned → session dead");
        this._onDead?.();
      }, RTC_DEAD_GRACE_MS);
    }
  }

  _pickAdapter(channel) {
    const cfg = this._profile.channels[channel];
    if (!cfg) return null;

    const candidates = [...this._adapters.values()]
      // Control must not ride a zombie RTC — a silent-but-open DC blackholes
      // broadcasts until the heartbeat closes it; route to WS/buffer instead.
      .filter((a) => a.supports(channel) && a.ready && !(channel === CHANNELS.control && a.staleForControl?.()));

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const pB = b.getPriority ? b.getPriority(channel) : (b.constructor.priority[channel] ?? 0);
      const pA = a.getPriority ? a.getPriority(channel) : (a.constructor.priority[channel] ?? 0);
      if (pB !== pA) return pB - pA;
      if (cfg.prefer) {
        if (b.constructor.id === cfg.prefer) return 1;
        if (a.constructor.id === cfg.prefer) return -1;
      }
      return 0;
    });

    return candidates[0] || null;
  }

  hasReadyAdapter() {
    return Boolean(this._pickAdapter(CHANNELS.control) || this._pickAdapter(CHANNELS.binary));
  }

  /** Application-facing send: log in the replay ring, then ship the unsent tail. */
  _sendControl(event, args, ackId) {
    // Stream control is logged too, so an ack or a gap request survives a carrier swap.
    if (event === STREAM_EVENTS.ACK || event === STREAM_EVENTS.GAP || event === STREAM_EVENTS.GAP_MISS) {
      this._sendStreamEvent(event, args?.[0], ackId);
      return;
    }
    this._legacyB64Down(event, args);
    this._countOutput(event, args);
    this._outLog.append({ event, args, ackId });
    this._ship();
  }

  /**
   * One door for every send: drain the ring's unsent tail on the best carrier.
   * A refusal stops the drain and the next carrier event resumes it.
   */
  _ship() {
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    for (const queued of this._outLog.unsentList()) {
      if (!this._sendOn(adapter, queued)) return;
      this._outLog.markSent(queued.sq);
    }
  }

  _countOutput(event, args) {
    if (event !== "output") return;
    const st = this._stats;
    if (args[0]?.enc === "bin") {
      st.binChunks++;
      if (!st.binAnnounced) {
        st.binAnnounced = true;
        logger.info(`[binout] FIRST binary output chunk sent → ${args[0].sessionId}`);
      }
    } else st.b64Chunks++;
  }

  /** One envelope on the best carrier, stamped with seq/epoch/watermark. */
  _sendOn(adapter, env) {
    const wire = {
      event: env.event,
      args: env.args || [],
      ackId: env.ackId ?? null,
      sq: env.sq ?? null,
      ep: this._seqEpoch,
      rs: this._intakeSeq.applied
    };
    try {
      if (adapter.constructor.id === "ws") {
        // socket.io carries no envelope fields — wrap it, and only for a peer that
        // announced seq control (an old client would treat it as a stray event).
        this._stats.sentWs++;
        if (!this._peerSeqCtl) return adapter.send(CHANNELS.control, { event: env.event, args: env.args });
        return adapter.send(CHANNELS.control, { event: STREAM_EVENTS.ENV, args: [wire] });
      }
      this._stats.sentRtc++;
      return adapter.send(CHANNELS.control, wire);
    } catch (err) {
      logger.warn(`send ${env.event} failed: ${err.message}`);
      return false;
    }
  }

  /** Stream-owned event (ack, gap request/notice) — logged, so it survives a swap. */
  _sendStreamEvent(event, arg, ackId) {
    this._outLog.append({ event, args: arg === undefined ? [] : [arg], ackId: ackId ?? null });
    this._ship();
  }

  /** Downgrade binary output to base64 for peers without caps.binOut. */
  _legacyB64Down(event, args) {
    if (this._binOut || event !== "output") return;
    const p = args[0];
    if (p?.enc === "bin" && Buffer.isBuffer(p.data)) {
      args[0] = { ...p, enc: "b64", data: p.data.toString("base64") };
    }
  }

  _reportStats() {
    const st = this._stats;
    const out = st.binChunks + st.b64Chunks;
    if (!out && !st.sentRtc && !st.sentWs) return;
    const binPct = out ? Math.round((st.binChunks / out) * 100) : 0;
    const rtcPct = (st.sentRtc + st.sentWs) ? Math.round((st.sentRtc / (st.sentRtc + st.sentWs)) * 100) : 0;
    logger.info(
      `[stats] output=${out} (bin ${binPct}% / b64 ${100 - binPct}%) | control rtc=${rtcPct}% (${st.sentRtc}/${st.sentRtc + st.sentWs}) | env2=${this._adapters.get("rtc")?._peerEnv2 ? "on" : "off"} binOut=${this._binOut ? "on" : "off"}`
    );
    st.binChunks = 0; st.b64Chunks = 0; st.sentRtc = 0; st.sentWs = 0;
  }

  /** A carrier event — replay the unconfirmed window (lane switch loses nothing),
   *  then resume gap repair. The peer's sequencer dedupes what it already had. */
  _flushBuffer() {
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    this._intakeSeq.setPaused(false);
    for (const queued of this._outLog.replayList()) {
      if (!this._sendOn(adapter, queued)) return;
      this._outLog.markSent(queued.sq);
    }
  }

  /** Dispatch incoming message from RTC or WS. Every envelope goes through the
   *  sequencer — including stream events, so seq continuity is never skipped
   *  (a hole only stream events could have filled would NACK forever). */
  _dispatch(event, payload, source, wsArgs) {
    // WS carries the envelope wrapper; RTC carries the same fields inline.
    const wrapped = source !== "rtc" && event === STREAM_EVENTS.ENV;
    const env = source === "rtc"
      ? payload
      : (wrapped ? wsArgs?.[0] : { event, args: wsArgs, ackId: null });
    if (!env?.event) return;
    // Who already dispatched this to socket.io handlers: RTC and the __env
    // wrapper bypass socket.io's pipeline; a plain WS event on a REAL socket
    // went through it (and socket.use) — invoking handlers again would double-fire.
    env._manual = source === "rtc" || wrapped;
    if (Number.isInteger(env.rs)) this._outLog.setApplied(env.rs);
    // A peer that speaks the stream is armed from its first stamped envelope, so
    // the transition to caps never produces a false gap.
    if (Number.isInteger(env.sq) && !this._intakeSeq.armed && this._peerSeqCtl) this._intakeSeq.arm();
    this._intakeSeq.push(env);
  }

  _onCaps(caps) {
    if (caps?.binOut) this._binOut = true;
    if (caps?.seqCtl && !this._peerSeqCtl) {
      this._peerSeqCtl = true;
      logger.info(`[seq] peer=${this._deviceId?.slice(0, 12) || "?"} announced seqCtl → stream armed`);
    }
    this._peerCaps = caps || {};
    this._adapters.get("rtc")?.setPeerCaps?.(this._peerCaps);
  }

  /** Deliver one envelope to its handlers exactly once (sequencer output). */
  _deliver(env) {
    switch (env.event) {
      case STREAM_EVENTS.ACK:
        this._dispatchAck(env);
        return;
      case STREAM_EVENTS.GAP:
        this._serveGap(env.args?.[0]);
        return;
      case STREAM_EVENTS.GAP_MISS:
        this._intakeSeq.gapMissed(env.args?.[0]?.from);
        return;
      case "caps":
        // Metadata first, then fall through — SessionHandler listens for "caps"
        // (fragOut negotiation) exactly like any application event.
        this._onCaps(env.args?.[0] ?? env);
        break;
      default:
        break;
    }
    const args = Array.isArray(env.args) ? [...env.args] : [];
    if (env.ackId) args.push((...resp) => this._sendAck(env.ackId, resp));
    // HostBus (virtual) is always manual; a real socket.io socket dispatched
    // plain WS events itself — only RTC/__env-carried ones need the handoff.
    if (env._manual || this._host?.dispatchAny) {
      // Manual invocation bypasses socket.io's pipeline, and onAny fires BEFORE
      // socket.use — so the admission rule must be applied HERE, not left to
      // socket.io. HostBus.listeners() already filters itself.
      if (!this._host?.dispatchAny && !this._host?.data?.localUi) {
        const conn = this._host?.data?.conn;
        const allowed = conn ? conn.allows(env.event) : AUTH_EVENTS.has(env.event);
        if (!allowed) {
          logger.warn(`[seq] drop unapproved event=${env.event} peer=${this._deviceId?.slice(0, 12) || "?"}`);
          return;
        }
      }
      const fns = this._host?.listeners?.(env.event) || [];
      for (const fn of fns) fn(...args);
      this._host?.dispatchAny?.(env.event, args[0]);
    }
  }

  _dispatchAck(env) {
    const target = this._pendingAcks?.get(env.ackId);
    if (!target) return;
    this._pendingAcks.delete(env.ackId);
    target(...(env.args || []));
  }

  /** Peer asked for [from..to] from our replay ring. */
  _serveGap({ from, to } = {}) {
    const range = this._outLog.range(from, to);
    if (!range) {
      this._sendStreamEvent(STREAM_EVENTS.GAP_MISS, { from });
      return;
    }
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    let n = 0;
    for (const env of range) {
      if (!this._sendOn(adapter, env)) break;
      n++;
    }
    this._seqStats.replayed += n;
  }

  /** Route incoming binary frame to "file-bin" listeners. */
  _onBinary(msg) {
    if (!msg || msg.channel !== "file") return;
    const fns = this._host?.listeners?.("file-bin") || [];
    for (const fn of fns) fn(msg.buffer);
  }

  /** Ack for an inbound request. Sequenced like everything else, so a carrier
   *  dying mid-answer re-sends it instead of leaving the peer to time out. */
  _sendAck(ackId, resp) {
    // args = resp spread, matching the old __ack wire shape (cb(...resp)).
    this._outLog.append({ event: STREAM_EVENTS.ACK, args: Array.isArray(resp) ? resp : [resp], ackId });
    this._ship();
  }

  _sendSignaling(msg) {
    if (isSignalingReady() && sendGlobalSignaling({ ...msg, to: this._deviceId })) return;
    if (msg.type === "answer") {
      this._sigBuffer = this._sigBuffer.filter((m) => m.type !== "answer" && m.type !== "ice");
    }
    this._sigBuffer.push(msg);
    if (this._sigBuffer.length > 32) this._sigBuffer.shift();
  }

  _flushSigBuffer() {
    if (!this._sigBuffer.length) return;
    const queued = this._sigBuffer;
    this._sigBuffer = [];
    for (const msg of queued) this._sendSignaling(msg);
  }
}
