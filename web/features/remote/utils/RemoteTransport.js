/**
 * RemoteTransport — unified transport layer for WS and WebRTC DataChannel.
 *
 * Exposes a Socket.IO-like interface (emit / on / off) so all consumers
 * (useTiles, useRemoteSocket, ...) work identically regardless of transport.
 *
 * Strategy:
 *   - SEND  : prefer DC when open, fallback to socket
 *   - RECEIVE: socket handles all JSON events (control + hashes)
 *              DC delivers binary tile frames → decoded off-thread via Worker → re-emitted as "tiles-data"
 */

let _worker = null;
let _workerMsgId = 0;
// Consecutive worker crashes before giving up — a worker that fails to load (CSP)
// errors again on every respawn, so bound the retries instead of looping forever.
const MAX_WORKER_RESPAWNS = 3;
let _workerFailures = 0;
// Map<id, resolve> for pending worker messages
const _workerPending = new Map();
// Track latest server timestamp seen per tileIndex — drop stale batches before emit
const _latestTileTs = new Map();
// Accumulate decoded chunks — flush after all pending onmessage callbacks drain
let _pendingEmit = null;
let _flushTimer = null;

function getWorker() {
  if (_worker === false) return null; // previously failed (CSP / unsupported)
  if (_worker) return _worker;
  try {
    // Next.js: use URL constructor for worker bundling
    _worker = new Worker(
      new URL("../workers/tileDecoder.worker.js", import.meta.url)
    );
  } catch {
    _worker = false;
    return null;
  }
  _worker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }) => {
    _workerFailures = 0; // worker answered — the crash streak is broken
    const resolve = _workerPending.get(id);
    if (!resolve) return;
    _workerPending.delete(id);
    resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err) => {
    console.error("[Worker] tileDecoder error:", err.message);
    // A crashed worker never answers — reset so the next tile spawns a fresh one
    resetWorker();
    if (++_workerFailures >= MAX_WORKER_RESPAWNS) _worker = false;
  };
  return _worker;
}

// Terminate the (possibly suspended/crashed) worker + drop pending decodes.
// Mirrors WebRtcProtocol.resetWorker / useTiles.resetBinWorker.
function resetWorker() {
  if (_worker && _worker !== false) { try { _worker.terminate(); } catch {} }
  _worker = null;
  for (const resolve of _workerPending.values()) { try { resolve(null); } catch {} }
  _workerPending.clear();
}

export class RemoteTransport {
  constructor(socket) {
    this._socket = socket;
    this._dc = null;            // RTCDataChannel, set when DC opens
    this._tileBatch = [];

    // Internal event bus for DC-originated events
    // Map<eventName, Set<handler>>
    this._listeners = new Map();

    // Proxy all socket events into our listener bus so consumers
    // use transport.on() for both WS and DC events uniformly
    this._socketProxy = (eventName) => (...args) => {
      this._emit(eventName, ...args);
    };
    this._proxiedEvents = new Map(); // eventName → proxy fn (for cleanup)
    
    // Track transport method for benchmark
    this._lastTransport = null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a listener. Works for both WS events and DC-decoded events.
   */
  on(eventName, handler) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
      // Mirror socket event into our bus (only once per event name)
      const proxy = (...args) => {
        // Tag WS events with transport method
        if (eventName === "tiles-data" && args[0] && !args[0].transport) {
          args[0].transport = "ws";
        }
        this._emit(eventName, ...args);
      };
      this._proxiedEvents.set(eventName, proxy);
      this._socket?.on(eventName, proxy);
    }
    this._listeners.get(eventName).add(handler);
  }

  /**
   * Remove a listener. Cleans up socket proxy when no handlers remain.
   */
  off(eventName, handler) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._listeners.delete(eventName);
      const proxy = this._proxiedEvents.get(eventName);
      if (proxy) {
        this._socket?.off(eventName, proxy);
        this._proxiedEvents.delete(eventName);
      }
    }
  }

  /**
   * Send via DC if open, else via socket (WS).
   * Binary data always goes through socket as a normal emit.
   */
  emit(eventName, data) {
    // Control/signaling always via socket (WS)
    this._socket?.emit(eventName, data);
  }

  /**
   * Attach an open RTCDataChannel. Transport will decode binary tiles
   * from it and re-emit as "tiles-data" — identical to WS path.
   */
  attachDataChannel(dc) {
    this._dc = dc;
    dc.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer)) return;
      this._receiveDCTile(data);
    };
    dc.onclose = () => {
      this._dc = null;
    };
  }

  /**
   * Detach DataChannel (DC closed or fallback).
   */
  detachDataChannel() {
    if (this._dc) {
      this._dc.onmessage = null;
      this._dc.onclose = null;
      this._dc = null;
    }
    this._tileBatch = [];
    _latestTileTs.clear();
    _pendingEmit = null;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  }

  /**
   * Full cleanup — remove all socket proxies and DC listeners.
   */
  destroy() {
    this.detachDataChannel();
    for (const [eventName, proxy] of this._proxiedEvents.entries()) {
      this._socket?.off(eventName, proxy);
    }
    this._proxiedEvents.clear();
    this._listeners.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /** Dispatch event to all registered handlers */
  _emit(eventName, ...args) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    for (const handler of set) handler(...args);
  }

  /** Decode batch tiles from DC via Worker (off main thread), emit as "tiles-data" */
  _receiveDCTile(buffer) {
    const id = ++_workerMsgId;

    new Promise((resolve) => {
      const worker = getWorker();
      if (!worker) return resolve(null);
      _workerPending.set(id, resolve);
      worker.postMessage({ buffer, id }, [buffer]);
    }).then((result) => {
      if (!result) return;
      const { tiles, timestamp, hasBitmap } = result;

      // Merge into pending emit — newer tile overwrites older for same tileIndex
      if (!_pendingEmit) {
        _pendingEmit = { tiles: new Map(), timestamp, hasBitmap };
      }
      for (const tile of tiles) {
        const prev = _latestTileTs.get(tile.tileIndex) ?? 0;
        if (timestamp >= prev) {
          _latestTileTs.set(tile.tileIndex, timestamp);
          // Close old bitmap if overwriting
          _pendingEmit.tiles.get(tile.tileIndex)?.bitmap?.close?.();
          _pendingEmit.tiles.set(tile.tileIndex, tile);
          if (timestamp > _pendingEmit.timestamp) _pendingEmit.timestamp = timestamp;
        } else {
          tile.bitmap?.close?.();
        }
      }

      // Flush via setTimeout(0) — macrotask runs after ALL pending onmessage callbacks
      // This ensures chunks from same frame are merged before emitting
      if (_flushTimer) clearTimeout(_flushTimer);
      const self = this;
      _flushTimer = setTimeout(() => {
        _flushTimer = null;
        if (!_pendingEmit) return;
        const { tiles: tileMap, timestamp: ts, hasBitmap: hb } = _pendingEmit;
        _pendingEmit = null;
        const freshTiles = [...tileMap.values()];
        if (!freshTiles.length) return;
        self._emit("tiles-data", { tiles: freshTiles, timestamp: ts, hasBitmap: hb, transport: "webrtc" });
      }, 0);
    });
  }
  
  /**
   * Get current transport method (webrtc or ws)
   */
  getTransport() {
    return this._dc ? "webrtc" : "ws";
  }
}
