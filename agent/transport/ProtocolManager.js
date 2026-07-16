import { WsProtocol } from "./WsProtocol.js";
import { WebRtcProtocol } from "./WebRtcProtocol.js";
import { registerProtocol, getProtocol } from "./registry.js";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE } from "../lib/transportConstants.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";

registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

/**
 * Server ProtocolManager — per-client orchestrator.
 *
 * Backward-compat API kept (emit, sendTiles, init, setupSignaling, close, type).
 */
export class ProtocolManager {
  constructor(socket, config) {
    const profileId = config.enableWebRTC ? "remoteDesktop" : "clientApp";
    const profile = { ...TRANSPORT_PROFILES[profileId] };
    if (!config.enableWebRTC) profile.enabled = ["ws"];

    profile.rtc = {
      enableTurn: Boolean(config.apiKey && config.turnApiUrl),
      turnApiUrl: config.turnApiUrl || null,
      turnRefreshInterval: config.turnRefreshInterval,
      dcMaxMessageSize: config.dcMaxMessageSize,
      answerTimeout: config.answerTimeout
    };

    this._profile = profile;
    this._auth = { apiKey: config.apiKey || null, socketId: socket.id };
    this._socket = socket;
    this._wsChunkSize = config.wsChunkSize;
    this._dcChunkSize = config.dcChunkSize;
    this._dcMaxTilesPerFrame = config.dcMaxTilesPerFrame;
    this._maxControlBuffer = config.maxControlBuffer;

    this._adapters = new Map();
    this._listeners = new Map();
    this._buffer = [];
    this._rtcSignalingHandler = null;
    this._sigListeners = null;
    this._wsPendingSince = new Map();
    // Pending-since timestamps — RTC backpressure priority, mirrors WS path.
    this._rtcPendingSince = new Map();
  }

  get type() {
    const adapter = this._pickAdapter(CHANNELS.binary);
    return adapter?.constructor.id === "rtc" ? "dc" : "ws";
  }

  // ─── Public API (legacy) ───────────────────────────────────────────────────

  async init() {
    for (const id of this._profile.enabled) {
      const Adapter = getProtocol(id);
      if (!Adapter) continue;
      const inst = new Adapter();
      inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
      inst.on("message", ({ event, data, source }) => this._dispatch(event, data, source));
      this._adapters.set(id, inst);

      const ctx = this._buildCtx(id);
      await inst.connect(ctx);
    }
  }

  setupSignaling(_socket) {
    // Adapter is set up via init(). Signaling listeners installed when RTC requests them.
    this._installSignalingListeners();
  }

  /** Always control channel — same as legacy "WS emit" */
  emit(event, ...args) {
    this._sendControl(event, args);
  }

  /**
   * Tiles: prefer binary channel via RTC if ready, else WS chunked.
   * Returns array of tiles actually sent (adapter may drop chunks under backpressure).
   */
  sendTiles(payload, encodeBatch) {
    const { tiles, timestamp } = payload;
    if (!tiles?.length) return [];

    const adapter = this._pickAdapter(CHANNELS.binary);
    const frameTs = timestamp ?? Date.now();

    if (adapter?.constructor.id === "rtc" && encodeBatch) {
      return this._emitTilesRtc(adapter, tiles, frameTs, encodeBatch);
    }
    // WS path — chunked binary emit
    return this._emitTilesChunked(tiles, frameTs);
  }

  close() {
    for (const inst of this._adapters.values()) {
      try { inst.disconnect(); } catch {}
    }
    this._adapters.clear();
    this._buffer = [];
  }

  /**
   * Make socket.emit route through this PM (control channel).
   * Stores raw emit on socket._rawEmit so adapters can bypass the wrapper.
   * Reserved socket.io events still go raw to avoid breaking socket.io semantics.
   */
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

  // ─── Internal ──────────────────────────────────────────────────────────────

  // Returns tiles actually sent; stops on first dropped chunk (backpressure)
  // so remaining tiles keep old hash and retry next frame.
  // WS prioritizes tiles that have been pending longest, using fresh tile data
  // from the current frame instead of resending stale buffers.
  _emitTilesChunked(tiles, frameTs) {
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
      if (ws.send(CHANNELS.binary, encodeTilesBatch(chunk, frameTs)) === false) {
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

  // RTC tile path — chunked binary DC, same sent-acknowledgement contract as WS.
  // Chunk size is probed down from dcChunkSize so each encoded chunk fits
  // dcMaxMessageSize (SCTP hard limit). Single tile still over max → salvage via
  // WS (no SCTP limit) to avoid infinite re-encode loop. Order and backpressure
  // mirror _emitTilesChunked: oldest-pending tile first, mark remaining on drop.
  // Returns tiles actually sent; stops on first RTC backpressure.
  _emitTilesRtc(rtc, tiles, frameTs, encodeBatch) {
    const max = this._profile.rtc?.dcMaxMessageSize ?? 65536;
    const n = tiles.length;
    const pendingSince = this._rtcPendingSince;
    const now = frameTs ?? Date.now();
    // Oldest-pending first — skipped tiles get priority next frame (same as WS).
    const ordered = [...tiles].sort((a, b) => {
      const ap = pendingSince.get(a.tileIndex) ?? Infinity;
      const bp = pendingSince.get(b.tileIndex) ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.tileIndex - b.tileIndex;
    });
    const chunkTiles = (cs) => ordered.slice(0, cs);
    // Probe — shrink until the actual first chunk fits SCTP max
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
        // Single tile over SCTP max — salvage via WS to avoid infinite re-encode
        if (chunk.length === 1 && ws?.ready && ws.send(CHANNELS.binary, buf) !== false) {
          pendingSince.delete(chunk[0].tileIndex);
          sent.push(...chunk);
        }
        // else multi-tile (probe missed — retry next frame) or WS down: keep old hash
        continue;
      }
      if (rtc.send(CHANNELS.binary, buf) === false) {
        // Backpressure — mark this chunk + remaining as pending so they are
        // prioritized next frame. Caller retries with fresh tile data.
        for (let j = i; j < n; j++) {
          const tileIndex = ordered[j].tileIndex;
          if (!pendingSince.has(tileIndex)) pendingSince.set(tileIndex, now);
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
        on: (handler) => { this._rtcSignalingHandler = handler; this._installSignalingListeners(); },
        off: () => { this._rtcSignalingHandler = null; this._removeSignalingListeners(); }
      };
    }
    return ctx;
  }

  _onAdapterStateChange(adapterId, state) {
    if (state === ADAPTER_STATE.open) this._flushBuffer();
  }

  _pickAdapter(channel) {
    const cfg = this._profile.channels[channel];
    if (!cfg) return null;

    const candidates = [...this._adapters.values()]
      .filter((a) => a.supports(channel) && a.ready);

    if (cfg.prefer) {
      const preferred = candidates.find((a) => a.constructor.id === cfg.prefer);
      if (preferred) return preferred;
    }
    candidates.sort((a, b) =>
      (b.constructor.priority[channel] ?? 0) - (a.constructor.priority[channel] ?? 0)
    );
    return candidates[0] || null;
  }

  // True if any adapter is ready to carry control or binary (broadcast gate)
  hasReadyAdapter() {
    return Boolean(this._pickAdapter(CHANNELS.control) || this._pickAdapter(CHANNELS.binary));
  }

  _sendControl(event, args, ackId) {
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) {
      this._buffer.push({ event, args, ackId });
      // Bound buffer — drop oldest when no adapter ready for too long
      if (this._buffer.length > this._maxControlBuffer) this._buffer.shift();
      return;
    }
    if (adapter.constructor.id === "rtc") {
      const ok = adapter.send(CHANNELS.control, { event, args, ackId });
      // RTC DC may silently drop (dead SCTP during ice transient) → fallback WS so the
      // client (likely already on WS) still receives server control like "output".
      if (ok) return;
      const ws = this._adapters.get("ws");
      if (ws?.ready && ws.send(CHANNELS.control, { event, args })) return;
    } else if (adapter.send(CHANNELS.control, { event, args })) {
      return;
    }
    // Couldn't deliver on any adapter — buffer for next ready window.
    this._buffer.push({ event, args, ackId });
    if (this._buffer.length > this._maxControlBuffer) this._buffer.shift();
  }

  _flushBuffer() {
    if (!this._buffer.length) return;
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    while (this._buffer.length) {
      const { event, args, ackId } = this._buffer.shift();
      this._sendControl(event, args, ackId);
    }
  }

  /**
   * Dispatch incoming message.
   * RTC envelope: {event, args, ackId?} — synthesize callback that emits __ack back.
   * WS source: socket.io already dispatched natively; only invoke internal PM listeners.
   */
  _dispatch(event, payload, source) {
    if (source === "rtc") {
      const args = Array.isArray(payload?.args) ? [...payload.args] : [];
      const ackId = payload?.ackId;
      if (ackId) {
        // Synthesize ack callback as last argument
        args.push((...resp) => this._sendAck(ackId, resp));
      }
      const set = this._listeners.get(event);
      if (set) for (const h of set) h(...args);
      const fns = this._socket.listeners?.(event) || [];
      for (const fn of fns) fn(...args);
      return;
    }
    // WS source — socket.io already fired raw listeners; only invoke PM bus
    const set = this._listeners.get(event);
    if (set) for (const h of set) h(payload);
  }

  _sendAck(ackId, resp) {
    const adapter = this._adapters.get("rtc");
    if (adapter?.ready && adapter.send(CHANNELS.control, { event: "__ack", args: resp, ackId })) return;
    // RTC dead/unavailable → ack rides WS so the client request doesn't hang.
    const ws = this._adapters.get("ws");
    if (ws?.ready) ws.send(CHANNELS.control, { event: "__ack", args: resp, ackId });
  }

  // ─── Signaling routing ─────────────────────────────────────────────────────

  _sendSignaling(msg) {
    const ws = this._adapters.get("ws");
    if (ws?.ready) {
      ws.send(CHANNELS.control, { event: this._sigEvent(msg.type), args: [this._sigData(msg)] });
      return;
    }
    // Server has no HTTP fallback for signaling outbound — log only
    console.warn("[ProtocolManager] signaling unavailable (ws down)");
  }

  _sigEvent(type) {
    return type === "offer" ? "webrtc:offer"
      : type === "answer" ? "webrtc:answer"
      : type === "ice" ? "webrtc:ice-candidate"
      : "webrtc:error";
  }

  _sigData(msg) {
    if (msg.type === "offer" || msg.type === "answer") return { sdp: msg.sdp };
    if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
    return msg;
  }

  _installSignalingListeners() {
    if (!this._rtcSignalingHandler || this._sigListeners) return;
    const onOffer = ({ sdp }) => this._rtcSignalingHandler?.({ type: "offer", sdp });
    const onIce = ({ candidate, mid }) => this._rtcSignalingHandler?.({ type: "ice", candidate, mid });
    this._sigListeners = { onOffer, onIce };
    this._socket.on("webrtc:offer", onOffer);
    this._socket.on("webrtc:ice-candidate", onIce);
  }

  _removeSignalingListeners() {
    if (!this._sigListeners) return;
    this._socket.off("webrtc:offer", this._sigListeners.onOffer);
    this._socket.off("webrtc:ice-candidate", this._sigListeners.onIce);
    this._sigListeners = null;
  }
}
