import { WsProtocol } from "./WsProtocol.js";
import { WebRtcProtocol } from "./WebRtcProtocol.js";
import { registerProtocol, getProtocol } from "./registry.js";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, CONTROL_RTC_MAX_BYTES, RTC_DEAD_GRACE_MS, SIGNALING_ERRORS } from "../lib/transportConstants.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";
import { isDeviceRejected } from "../lib/deviceApproval.js";
import { onSignalingMessage, onSignalingReady, sendSignaling as sendGlobalSignaling, isSignalingReady } from "../lib/signalingGlobal.js";
import { pushTransportState } from "../api/ui.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("transport");

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
    this._auth = { apiKey: config.apiKey || null, socketId: socket?.id || null };
    this._socket = socket || null;
    // Handler host — where feature handlers are registered. For an RTC-only
    // session this is the VirtualSocket and stays so even after a real socket
    // late-attaches, so handlers are never registered twice.
    this._host = socket || null;
    this._wsChunkSize = config.wsChunkSize;
    this._dcChunkSize = config.dcChunkSize;
    this._dcMaxTilesPerFrame = config.dcMaxTilesPerFrame;
    this._maxControlBuffer = config.maxControlBuffer;
    // Signaling peer id — "deviceId:tab" for DO-routed clients (two tabs of one
    // browser share a deviceId), plain deviceId on the socket.io path.
    this._deviceId = config.signaling?.deviceId || null;
    // Device identity for the approval re-check — strip the per-tab suffix.
    this._approvalDeviceId = this._deviceId ? this._deviceId.split(":")[0] : null;
    // Outbound signaling buffered until a carrier (WS tunnel or DO global) is ready.
    this._sigBuffer = [];

    this._adapters = new Map();
    this._listeners = new Map();
    this._buffer = [];
    this._binOut = false; // peer announced caps.binOut — output bytes may ride binary
    this._rtcSignalingHandler = null;
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
      // Virtual (RTC-only) session — no real socket.io yet. WS attaches later
      // via attachSocket() when the tunnel comes up.
      if (id === "ws" && this._host?.isVirtual) continue;
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
        // Native addon missing/broken (e.g. blocked install script) — degrade to WS-only.
        if (id === "rtc") {
          console.warn(`[ProtocolManager] WebRTC unavailable — remote desktop over WS only. (${err.message})`);
          continue;
        }
        throw err;
      }
      this._adapters.set(id, inst);
    }
    // Arm DO signaling as part of init: the two used to be separate calls, and
    // any await between them was a window where an inbound offer had no handler.
    // Idempotent — setupSignaling is also called on its own to re-arm after the
    // RTC debug toggle (see broadcast.notifyRtcEnabled).
    this.setupSignaling(this._socket);
  }

  /**
   * Late-attach a real socket.io socket to an RTC-only session (tunnel came up
   * after RTC connected). Adds WS as a fallback carrier; the virtual socket
   * stays the handler host so features are never re-registered.
   */
  async attachSocket(socket) {
    if (!socket || this._adapters.has("ws")) return;
    // Claim the slot BEFORE the await below: two sockets attaching at once
    // (tunnel reconnect racing the RTC-session hand-off) would both clear the
    // has("ws") check, build two adapters, and leak the first one.
    // A concurrent attach is already building the carrier. Chain onto it rather
    // than returning its promise: this call carries a DIFFERENT socket, and
    // handing back the other one's result would silently drop this one.
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
    // Tunnel died — drop the WS carrier so a later reconnect can attach again.
    socket.on("disconnect", () => {
      if (this._adapters.get("ws") !== inst) return;
      this._adapters.delete("ws");
      this._socket = null;
      try { inst.disconnect(); } catch {}
    });
    this._flushBuffer();
  }

  setupSignaling(_socket) {
    if (this._offGlobalSig) return; // already armed (init did it, or a re-arm ran)
    // Register with the process-wide DO signaling client, keyed by the client
    // deviceId this PM serves. Buffered offers (arrived before this PM existed)
    // are flushed by onSignalingMessage. Device approval re-checked on offer.
    this._offGlobalSig = onSignalingMessage(this._deviceId, (msg) => {
      if (msg.type === "offer") {
        // Deliberately NOT gated on host approval. The key TAIL is proven over
        // this very channel (device:tailProof), and the host is only asked once
        // it is: refusing the offer until the device is approved closed the one
        // road the proof can travel, so the device could never be proven, never
        // be asked about, and never approved. Admission is decided in one place
        // — lib/deviceAuth.admissionGate, via the server's askGate — and the
        // session it guards carries nothing but auth until both gates pass.
        if (this._approvalDeviceId && isDeviceRejected(this._approvalDeviceId)) {
          this._sendSignaling({ type: "error", message: SIGNALING_ERRORS.rejected });
          return;
        }
        // No RTC handler (adapter killed by debug toggle or crash) — tell the
        // client now so it falls back to the tunnel instead of timing out ICE.
        if (!this._rtcSignalingHandler) {
          this._sendSignaling({ type: "error", message: "rtc-disabled" });
          return;
        }
      }
      this._rtcSignalingHandler?.(msg);
    });
    // Flush buffered outbound signaling once the DO carrier comes online.
    this._offGlobalReady = onSignalingReady(() => this._flushSigBuffer());
  }

  /** Always control channel — same as legacy "WS emit" */
  emit(event, ...args) {
    this._sendControl(event, args);
  }

  /** Recreate the RTC adapter after it was torn down by the test-toggle. Sets up
   *  a fresh answerer PeerConnection + the signaling handler (_buildCtx wires
   *  signaling.on → _rtcSignalingHandler), so the client's next offer is answered
   *  by THIS PM instead of spawning a second RTC-only PM. */
  restartRtc() {
    if (this._adapters.has("rtc")) return;
    const Adapter = getProtocol("rtc");
    if (!Adapter) return;
    try {
      const inst = new Adapter();
      inst.on("stateChange", (s) => this._onAdapterStateChange("rtc", s));
      inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source, args));
      inst.on("binary", (msg) => this._onBinary(msg));
      if (this._peerCaps) inst.setPeerCaps?.(this._peerCaps); // caps predate this instance
      this._adapters.set("rtc", inst);
      inst.connect(this._buildCtx("rtc"));
    } catch (e) {
      console.warn(`[ProtocolManager] restartRtc failed: ${e.message}`);
    }
  }

  /**
   * Send a binary payload on a channel (file transfer). Uses the best adapter
   * (RTC preferred). Unlike _sendControl, does NOT fall back to WS on RTC
   * backpressure — that's temporary (buffer drains in ms) and dumping chunks
   * to the tunnel wastes Cloudflare bandwidth + delivers out-of-order. RTC
   * death is handled by _pickAdapter (returns WS when RTC state != open).
   */
  sendBinary(channel, payload) {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
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
    this._closed = true;
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
        // RTC backpressure — spillover remaining to WS (parallel path). Client
        // merges by tileIndex+timestamp so no duplicate render. Falls back to
        // marking rtc-pending when WS is down, preserving old retry behavior.
        const remaining = ordered.slice(i);
        if (ws?.ready) {
          const wsSent = this._emitTilesChunked(remaining, frameTs);
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
    if (this._closed) return; // PM torn down — adapter state changes are noise
    logger.debug(`${adapterId}→${state} (carriers: ${[...this._adapters.entries()].map(([id, a]) => `${id}=${a.ready ? "ready" : a.state}`).join(" ")})`);
    pushTransportState();
    if (state === ADAPTER_STATE.open) {
      // Peer came back (re-offer after resume/handover) — cancel the teardown.
      clearTimeout(this._deadTimer);
      this._deadTimer = null;
      this._flushBuffer();
      return;
    }
    // RTC died on a virtual session with no WS to fall back to. The client is
    // already renegotiating over DO (resume, network handover), and its re-offer
    // lands on THIS pm's handler — tearing down now would unregister that
    // handler and strand the offer. Wait out the client's restart window; only
    // a peer that never comes back is really dead.
    if (state === ADAPTER_STATE.closed && adapterId === "rtc"
      && this._host?.isVirtual && !this._adapters.get("ws")?.ready) {
      clearTimeout(this._deadTimer);
      logger.debug(`rtc closed, no ws on a virtual session → ${RTC_DEAD_GRACE_MS}ms grace before declaring dead`);
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
    let adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) {
      this._buffer.push({ event, args, ackId });
      // Bound buffer — drop oldest when no adapter ready for too long
      if (this._buffer.length > this._maxControlBuffer) this._buffer.shift();
      return;
    }
    // Preemptive size-routing: SCTP DC rejects oversize control payloads (> CONTROL_RTC_MAX_BYTES)
    // with a throw/false, which can corrupt the channel into a zombie state. Route oversize
    // payloads to WS (no SCTP limit) before attempting RTC.
    if (adapter.constructor.id === "rtc" && _controlBytes(args) > CONTROL_RTC_MAX_BYTES) {
      const ws = this._adapters.get("ws");
      if (ws?.ready) adapter = ws;
    }
    // One conversion, before the carrier is even chosen — the payload is the same
    // envelope whichever adapter carries it.
    this._upgradeBin(event, args);
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

  /** caps.binOut peers take output bytes as a Buffer instead of a base64 string:
   *  25% less wire, zero client-side decode. Carrier-agnostic on purpose — each
   *  adapter already knows how to put a Buffer on its own wire (socket.io lifts it
   *  into a binary attachment; the RTC codec into a v2 frame part, or {__b} for a
   *  legacy peer), so this layer never asks which carrier is underneath.
   *  Idempotent: an already-converted payload (enc:"bin") passes through. */
  _upgradeBin(event, args) {
    if (!this._binOut || event !== "output") return;
    const p = args[0];
    if (p?.enc === "b64" && typeof p.data === "string") {
      args[0] = { ...p, enc: "bin", data: Buffer.from(p.data, "base64") };
    }
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
  _dispatch(event, payload, source, wsArgs) {
    // Client capability: caps.binOut peers take terminal output as a Buffer
    // attachment on WS (see _upgradeBin). RTC shape: {event, args}; WS: data=args[0].
    if (event === "caps") {
      const caps = source === "rtc" ? payload?.args?.[0] : (wsArgs?.[0] ?? payload);
      if (caps?.binOut) this._binOut = true;
      // Remembered on the PM, not only handed to the adapter: RTC is rebuilt on
      // renegotiation (restartRtc) and the fresh instance must not fall back to
      // the legacy wire form just because the announcement predates it.
      this._peerCaps = caps || {};
      this._adapters.get("rtc")?.setPeerCaps?.(this._peerCaps); // gates heartbeat + env2
    }
    if (source === "rtc") {
      const args = Array.isArray(payload?.args) ? [...payload.args] : [];
      const ackId = payload?.ackId;
      if (ackId) {
        // Synthesize ack callback as last argument
        args.push((...resp) => this._sendAck(ackId, resp));
      }
      const set = this._listeners.get(event);
      if (set) for (const h of set) h(...args);
      const fns = this._host?.listeners?.(event) || [];
      for (const fn of fns) fn(...args);
      this._host?.dispatchAny?.(event, args[0]);
      return;
    }
    // WS source — socket.io already fired raw listeners; only invoke PM bus.
    // Virtual host: handlers live on the VirtualSocket, forward full args (incl
    // ack callback from onAny) so gitChangedCount/getVapidKey etc. get their ack.
    const set = this._listeners.get(event);
    if (set) for (const h of set) h(payload);
    if (this._host?.isVirtual) {
      const fns = this._host.listeners?.(event) || [];
      const args = wsArgs || [payload];
      for (const fn of fns) fn(...args);
      this._host.dispatchAny?.(event, payload);
    }
  }

  /**
   * Incoming binary frame from an adapter's "binary" event (RTC DC "file").
   * Route to socket.io-style "file-bin" listeners so WS and RTC paths share one
   * handler (WS delivers "file-bin" natively via socket.io onAny).
   */
  _onBinary(msg) {
    if (!msg || msg.channel !== "file") return;
    const fns = this._host?.listeners?.("file-bin") || [];
    for (const fn of fns) fn(msg.buffer);
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
    // DO is the sole signaling carrier — the tunnel carries data only.
    if (isSignalingReady() && sendGlobalSignaling({ ...msg, to: this._deviceId })) return;
    // A queued answer belongs to a peer that has since been replaced, and its
    // ICE with it. Delivering the stale ones first only makes the client apply
    // an answer for a peer it already dropped — keep the newest exchange only.
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

// Approximate serialized size of control args — cheap upper bound for SCTP limit check.
function _controlBytes(args) {
  let bytes = 0;
  for (const a of args) bytes += _valueBytes(a);
  return bytes;
}

// Buffers must be measured by their byte length, not by JSON.stringify: a Buffer
// serializes to {"type":"Buffer","data":[171,171,…]} — roughly 10x its real size,
// which would push every binary output payload over the SCTP cap and off RTC.
// On the wire a Buffer costs its own length (v2 frame part / socket.io attachment).
function _valueBytes(v) {
  if (v == null) return 4;
  if (typeof v === "string") return v.length;
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return v.byteLength ?? v.length;
  if (Array.isArray(v)) {
    let n = 2;
    for (const x of v) n += _valueBytes(x) + 1;
    return n;
  }
  if (typeof v === "object") {
    let n = 2;
    for (const k of Object.keys(v)) n += k.length + 3 + _valueBytes(v[k]);
    return n;
  }
  return JSON.stringify(v)?.length ?? 8;
}
