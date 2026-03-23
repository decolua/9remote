import { BaseProtocol } from "./BaseProtocol";
import { API_ENDPOINTS } from "@/shared/constants/API";

// Module-level shared worker (one instance for all WebRtcProtocol instances)
let _worker = null;
let _workerMsgId = 0;
const _workerPending = new Map();

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(
    new URL("../../features/remote/workers/tileDecoder.worker.js", import.meta.url)
  );
  _worker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }) => {
    const resolve = _workerPending.get(id);
    if (!resolve) return;
    _workerPending.delete(id);
    resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err) => console.error("[Worker] tileDecoder:", err.message);
  return _worker;
}

/**
 * WebRtcProtocol — RTCDataChannel transport adapter.
 *
 * - Receives binary tile frames via DataChannel
 * - Decodes off main thread via tileDecoder Worker
 * - Re-emits as "tiles-data" — identical interface to WsProtocol
 * - Control events (emit) are intentionally a no-op: caller routes via WsProtocol
 */
export class WebRtcProtocol extends BaseProtocol {
  constructor({ socketRef, apiKey, enableTurn, onConnect, onDisconnect }) {
    super();
    this._socketRef = socketRef;
    this._apiKey = apiKey;
    this._enableTurn = enableTurn;
    this._onConnect = onConnect;
    this._onDisconnect = onDisconnect;

    this._pc = null;
    this._dc = null;
    this._connected = false;
    this._type = "dc-stun";

    // Internal event bus for decoded DC events
    this._listeners = new Map();

    // Pending emit accumulator — merge chunks before flushing
    this._pendingEmit = null;
    this._flushTimer = null;
    // Latest timestamp per tileIndex — drop stale tiles
    this._latestTileTs = new Map();

    // Named socket signaling handlers for clean removal
    this._signalingHandlers = {};
  }

  get type() { return this._type; }
  get connected() { return this._connected; }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  // WebRTC only handles incoming data — emit is no-op (WsProtocol handles control)
  emit(_event, _data) {}

  async connect() {
    this._cleanup();

    let iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    if (this._enableTurn) {
      try {
        const resp = await fetch(API_ENDPOINTS.turnCredentials, {
          headers: { "X-API-Key": this._apiKey }
        });
        if (resp.ok) {
          const data = await resp.json();
          iceServers = data.iceServers;
        }
      } catch (err) {
        console.warn("[WebRtcProtocol] TURN fetch failed:", err.message);
      }
    }

    const pc = new RTCPeerConnection({ iceServers });
    this._pc = pc;

    const dc = pc.createDataChannel("tiles", { ordered: false, maxRetransmits: 0 });
    dc.binaryType = "arraybuffer";
    this._dc = dc;

    dc.onopen = async () => {
      // Detect STUN vs TURN via ICE stats
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded") {
            const local = [...stats.values()].find((c) => c.id === s.localCandidateId);
            if (local?.candidateType === "relay") this._type = "dc-turn";
          }
        });
      } catch {}
      this._connected = true;
      this._onConnect?.(this._type);
    };

    dc.onclose = () => {
      this._connected = false;
      this._onDisconnect?.("dc-closed");
    };

    dc.onerror = (e) => {
      const msg = e.error?.message ?? "unknown";
      if (!msg.includes("User-Initiated")) console.error("[WebRtcProtocol] DC error:", msg);
    };

    dc.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) this._receiveTile(data);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._socketRef.current?.emit("webrtc:ice-candidate", {
          candidate: candidate.candidate,
          mid: candidate.sdpMid
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        this._cleanup();
        this._onDisconnect?.("ice-failed");
      }
    };

    // Signaling via WS socket
    const onIceCandidate = ({ candidate, mid }) => {
      pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: mid })).catch(() => {});
    };
    const onAnswer = async ({ sdp }) => {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      } catch (err) {
        this._cleanup();
        this._onDisconnect?.("sdp-error");
      }
    };
    const onError = ({ message }) => {
      console.error("[WebRtcProtocol] server error:", message);
      this._cleanup();
      this._onDisconnect?.("server-error");
    };

    this._signalingHandlers = { onIceCandidate, onAnswer, onError };
    const socket = this._socketRef.current;
    socket?.on("webrtc:ice-candidate", onIceCandidate);
    socket?.on("webrtc:answer", onAnswer);
    socket?.on("webrtc:error", onError);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit("webrtc:offer", { sdp: offer.sdp });
    } catch (err) {
      console.error("[WebRtcProtocol] createOffer error:", err.message);
      this._cleanup();
      this._onDisconnect?.("offer-error");
    }
  }

  disconnect() {
    this._cleanup();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _cleanup() {
    // Remove signaling listeners
    const socket = this._socketRef.current;
    const { onIceCandidate, onAnswer, onError } = this._signalingHandlers;
    if (onIceCandidate) socket?.off("webrtc:ice-candidate", onIceCandidate);
    if (onAnswer) socket?.off("webrtc:answer", onAnswer);
    if (onError) socket?.off("webrtc:error", onError);
    this._signalingHandlers = {};

    if (this._dc) {
      this._dc.onopen = null;
      this._dc.onclose = null;
      this._dc.onerror = null;
      this._dc.onmessage = null;
      this._dc.close();
      this._dc = null;
    }
    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.close();
      this._pc = null;
    }

    this._connected = false;
    this._pendingEmit = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._latestTileTs.clear();
  }

  /** Decode binary tile batch via Worker, emit as "tiles-data" */
  _receiveTile(buffer) {
    const id = ++_workerMsgId;
    new Promise((resolve) => {
      _workerPending.set(id, resolve);
      getWorker().postMessage({ buffer, id }, [buffer]);
    }).then((result) => {
      if (!result) return;
      const { tiles, timestamp, hasBitmap } = result;

      if (!this._pendingEmit) {
        this._pendingEmit = { tiles: new Map(), timestamp, hasBitmap };
      }
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

      // Flush after all pending onmessage drain (macrotask)
      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        if (!this._pendingEmit) return;
        const { tiles: tileMap, timestamp: ts, hasBitmap: hb } = this._pendingEmit;
        this._pendingEmit = null;
        const freshTiles = [...tileMap.values()];
        if (!freshTiles.length) return;
        this._dispatch("tiles-data", { tiles: freshTiles, timestamp: ts, hasBitmap: hb, transport: this._type });
      }, 0);
    });
  }

  _dispatch(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of set) handler(...args);
  }
}
