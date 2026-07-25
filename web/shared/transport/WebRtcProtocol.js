import { BaseProtocol } from "./BaseProtocol";
import { encode, decode } from "./codec";
import { API_ENDPOINTS } from "@/shared/constants/API";
import { ADAPTER_STATE, CHANNELS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Shared decoder worker (one instance for all WebRtcProtocol instances)
let _worker = null;
let _workerMsgId = 0;
const _workerPending = new Map();
// Per-pending decode timeout — a worker suspended/killed by iOS background or a crash
// stops answering; without this guard every pending decode promise hangs forever and
// tiles never draw (black canvas on the RTC path). Mirror useTiles.resetBinWorker.
const WORKER_DECODE_TIMEOUT_MS = 8000;

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL("../../features/remote/workers/tileDecoder.worker.js", import.meta.url));
  _worker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }) => {
    const entry = _workerPending.get(id);
    if (!entry) {
      // Batch was dropped by the queue cap before this result arrived — close the
      // orphan bitmaps the worker decoded so they don't leak GPU memory.
      if (tiles) for (const t of tiles) t.bitmap?.close?.();
      return;
    }
    clearTimeout(entry.timer);
    _workerPending.delete(id);
    entry.resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err) => {
    console.error("[Worker] tileDecoder:", err.message);
    // A crashed worker won't answer any pending decode — reset so the next tile spawns
    // a fresh worker instead of posting into a dead one.
    resetWorker();
  };
  return _worker;
}

// Terminate the (possibly suspended/crashed) worker + drop pending decodes so the next
// tile spawns a fresh worker. Mirrors useTiles.resetBinWorker (iOS background recovery).
function resetWorker() {
  if (_worker) { try { _worker.terminate(); } catch {} }
  _worker = null;
  for (const { resolve } of _workerPending.values()) { try { resolve(null); } catch {} }
  _workerPending.clear();
}

/**
 * WebRtcProtocol — RTCDataChannel transport adapter (browser).
 *
 * Two DCs:
 *   "control" — ordered/reliable — JSON control events
 *   "binary"  — unordered/unreliable — binary tile frames (decoded → "message" tiles-data)
 *
 * Signaling: cross-channel via ProtocolManager (defaults WS, falls back to HTTP).
 * Adapter is signaling-agnostic — gets `signaling` interface from connect ctx.
 */
export class WebRtcProtocol extends BaseProtocol {
  static id = "rtc";
  static capabilities = { control: true, binary: true, signaling: "external" };
  static priority = { control: 50, binary: 100 };

  constructor() {
    super();
    this._pc = null;
    this._dcControl = null;
    this._dcBinary = null;
    this._typeDetail = "dc-stun";

    this._pendingEmit = null;
    this._flushTimer = null;
    this._latestTileTs = new Map();

    this._signalingHandlers = {};
    this._signaling = null;
  }

  /**
   * @param {object} ctx
   * @param {object} ctx.auth         — { apiKey }
   * @param {object} ctx.profile      — { rtc: { enableTurn } }
   * @param {object} ctx.signaling    — { send(msg), on(handler), off() }
   */
  async connect(ctx) {
    this._ctx = ctx;
    this._cleanupPeer();
    this._setState(ADAPTER_STATE.connecting);

    // STUN cluster — benchmarked from VN: Google ~150ms, Twilio ~144ms, Cloudflare ~813ms
    let iceServers = [
      { urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
        "stun:stun3.l.google.com:19302",
        "stun:stun4.l.google.com:19302"
      ] },
      { urls: "stun:global.stun.twilio.com:3478" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ];
    if (ctx.profile?.rtc?.enableTurn) {
      try {
        const resp = await fetch(API_ENDPOINTS.turnCredentials, { headers: { "X-API-Key": ctx.auth.apiKey } });
        if (resp.ok) iceServers = (await resp.json()).iceServers;
      } catch (err) {
        console.warn("[WebRtcProtocol] TURN fetch failed:", err.message);
      }
    }

    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });
    this._pc = pc;

    const ordered = ctx.profile?.rtc?.dcControl?.ordered ?? true;
    const dcControl = pc.createDataChannel("control", { ordered });
    const dcBinary = pc.createDataChannel("binary", { ordered: false, maxPacketLifeTime: 500 });
    dcBinary.binaryType = "arraybuffer";
    dcControl.binaryType = "arraybuffer";
    this._dcControl = dcControl;
    this._dcBinary = dcBinary;

    const checkOpen = async () => {
      if (dcControl.readyState !== "open" || dcBinary.readyState !== "open") return;
      let pairInfo = "";
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded") {
            const local = [...stats.values()].find((c) => c.id === s.localCandidateId);
            const remote = [...stats.values()].find((c) => c.id === s.remoteCandidateId);
            if (local?.candidateType === "relay") this._typeDetail = "dc-turn";
            pairInfo = `local=${local?.candidateType}/${local?.protocol} remote=${remote?.candidateType}/${remote?.protocol}`;
          }
        });
      } catch {}
      debugLog("transport", `[rtc] dc OPEN type=${this._typeDetail} ${pairInfo}`);
      this._setState(ADAPTER_STATE.open);
    };

    dcControl.onopen = checkOpen;
    dcBinary.onopen = checkOpen;

    // Closed only when BOTH DCs gone — single DC close = degraded
    const handleClose = () => {
      const cClosed = !this._dcControl || this._dcControl.readyState === "closed";
      const bClosed = !this._dcBinary || this._dcBinary.readyState === "closed";
      if (cClosed && bClosed) this._setState(ADAPTER_STATE.closed);
      else this._setState(ADAPTER_STATE.degraded);
    };
    dcControl.onclose = handleClose;
    dcBinary.onclose = handleClose;

    dcControl.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[rtc] dcControl ERROR:", msg);
    };
    dcBinary.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[rtc] dcBinary ERROR:", msg);
    };

    dcControl.onmessage = ({ data }) => {
      let parsed;
      try { parsed = decode(data); }
      catch (err) { console.error("[rtc] control parse error:", err.message); return; }
      this._emit("message", { event: parsed.event, data: parsed, source: "rtc" });
    };

    dcBinary.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) this._receiveTile(data);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._sendSignaling({ type: "ice", candidate: candidate.candidate, mid: candidate.sdpMid });
    };

    pc.oniceconnectionstatechange = () => {
      debugLog("transport", `[rtc] iceState=${pc.iceConnectionState}`);
      // disconnected: transient — peer may recover. Only failed = terminal.
      if (pc.iceConnectionState === "disconnected") {
        this._setState(ADAPTER_STATE.degraded);
      } else if (pc.iceConnectionState === "failed") {
        this._cleanupPeer();
        this._setState(ADAPTER_STATE.closed);
      } else if (pc.iceConnectionState === "connected" && this._dcControl?.readyState === "open" && this._dcBinary?.readyState === "open") {
        this._setState(ADAPTER_STATE.open);
      }
    };

    // Setup signaling channel
    this._signaling = ctx.signaling;
    this._signaling?.on?.((msg) => this._handleSignal(msg));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      debugLog("transport", "[rtc] offer sent");
      this._sendSignaling({ type: "offer", sdp: offer.sdp });
    } catch (err) {
      console.error("[rtc] createOffer error:", err.message);
      this._cleanupPeer();
      this._setState(ADAPTER_STATE.closed);
    }
  }

  disconnect() {
    this._cleanupPeer();
    this._signaling?.off?.();
    this._signaling = null;
    this._setState(ADAPTER_STATE.closed);
  }

  send(channel, payload) {
    if (channel === CHANNELS.control) {
      if (this._dcControl?.readyState !== "open") return false;
      try {
        this._dcControl.send(encode({ event: payload.event, args: payload.args || [], ackId: payload.ackId || null }));
        return true;
      } catch (err) {
        console.error("[rtc] send control error:", err.message);
        return false;
      }
    }
    if (channel === CHANNELS.binary) {
      if (this._dcBinary?.readyState !== "open") return false;
      try {
        this._dcBinary.send(payload);
        return true;
      } catch (err) {
        console.error("[rtc] send binary error:", err.message);
        return false;
      }
    }
    return false;
  }

  get typeDetail() { return this._typeDetail; }

  // ─── Signaling ─────────────────────────────────────────────────────────────

  _sendSignaling(msg) {
    this._signaling?.send?.(msg);
  }

  async _handleSignal(msg) {
    if (!this._pc) return;
    try {
      if (msg.type === "answer") {
        await this._pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
      } else if (msg.type === "ice") {
        await this._pc.addIceCandidate(new RTCIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid })).catch(() => {});
      } else if (msg.type === "error") {
        console.error("[rtc] server error:", msg.message);
        this._cleanupPeer();
        this._setState(ADAPTER_STATE.closed);
      }
    } catch (err) {
      console.error("[rtc] signal handle error:", err.message);
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _cleanupPeer() {
    for (const dc of [this._dcControl, this._dcBinary]) {
      if (!dc) continue;
      dc.onopen = null; dc.onclose = null; dc.onerror = null; dc.onmessage = null;
      try { dc.close(); } catch {}
    }
    this._dcControl = null;
    this._dcBinary = null;
    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.oniceconnectionstatechange = null;
      try { this._pc.close(); } catch {}
      this._pc = null;
    }
    this._pendingEmit = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._latestTileTs.clear();
  }

  _receiveTile(buffer) {
    const id = ++_workerMsgId;
    const bytes = buffer.byteLength;
    new Promise((resolve) => {
      // Per-pending timeout — if the worker is suspended (iOS background) or dead it
      // never answers; resolve(null) drops this frame instead of hanging the promise.
      const timer = setTimeout(() => {
        if (!_workerPending.has(id)) return;
        _workerPending.delete(id);
        resolve(null);
      }, WORKER_DECODE_TIMEOUT_MS);
      // Bound the in-flight queue: if the worker can't keep up, drop the OLDEST
      // batch (first inserted ≈ oldest frame) so the newest frame always wins.
      const cap = REMOTE_CONFIG.decodeQueueCap;
      while (_workerPending.size >= cap) {
        const oldestId = _workerPending.keys().next().value;
        const old = _workerPending.get(oldestId);
        if (!old) break;
        clearTimeout(old.timer);
        _workerPending.delete(oldestId);
        old.resolve(null);
      }
      _workerPending.set(id, { resolve, timer });
      getWorker().postMessage({ buffer, id, v: 2 }, [buffer]);
    }).then((result) => {
      if (!result) return;
      const { tiles, timestamp, hasBitmap } = result;

      if (!this._pendingEmit) this._pendingEmit = { tiles: new Map(), timestamp, hasBitmap, bytes: 0 };
      this._pendingEmit.bytes += bytes;
      for (const tile of tiles) {
        const prev = this._latestTileTs.get(tile.tileIndex) ?? 0;
        if (timestamp >= prev) {
          this._latestTileTs.set(tile.tileIndex, timestamp);
          this._pendingEmit.tiles.get(tile.tileIndex)?.bitmap?.close?.();
          this._pendingEmit.tiles.set(tile.tileIndex, tile);
          if (timestamp > this._pendingEmit.timestamp) this._pendingEmit.timestamp = timestamp;
        } else {
          tile.bitmap?.close?.();
        }
      }

      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        if (!this._pendingEmit) return;
        const { tiles: tileMap, timestamp: ts, hasBitmap: hb, bytes: by } = this._pendingEmit;
        this._pendingEmit = null;
        const freshTiles = [...tileMap.values()];
        if (!freshTiles.length) return;
        // Emit as standard "message" → ProtocolManager fans out to "tiles-data" listeners
        this._emit("message", {
          event: "tiles-data",
          data: { tiles: freshTiles, timestamp: ts, hasBitmap: hb, bytes: by, transport: this._typeDetail },
          source: "rtc"
        });
      }, 0);
    });
  }
}
