/**
 * RemoteTransport — unified transport layer for WS and WebRTC DataChannel.
 *
 * Exposes a Socket.IO-like interface (emit / on / off) so all consumers
 * (useTiles, useRemoteSocket, ...) work identically regardless of transport.
 *
 * Strategy:
 *   - SEND  : prefer DC when open, fallback to socket
 *   - RECEIVE: socket handles all JSON events (control + hashes)
 *              DC delivers binary tile frames → decoded → re-emitted as "tiles-data"
 */

/**
 * Decode a single tile binary message from DataChannel.
 * Format: [20-byte header + N-byte JPEG]
 * Header: tileIndex(4) x(4) y(4) width(4) height(4)
 */
function decodeTileBinary(buffer) {
  const view = new DataView(buffer);
  return {
    tileIndex: view.getUint32(0, true),
    x:         view.getUint32(4, true),
    y:         view.getUint32(8, true),
    width:     view.getUint32(12, true),
    height:    view.getUint32(16, true),
    imageBuffer: buffer.slice(20)
  };
}

export class RemoteTransport {
  constructor(socket) {
    this._socket = socket;
    this._dc = null;            // RTCDataChannel, set when DC opens
    this._rafRef = null;
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
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a listener. Works for both WS events and DC-decoded events.
   */
  on(eventName, handler) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
      // Mirror socket event into our bus (only once per event name)
      const proxy = (...args) => this._emit(eventName, ...args);
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
    if (this._rafRef) {
      cancelAnimationFrame(this._rafRef);
      this._rafRef = null;
    }
    this._tileBatch = [];
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

  /** Decode binary tile from DC, batch via rAF, re-emit as "tiles-data" */
  _receiveDCTile(buffer) {
    try {
      this._tileBatch.push(decodeTileBinary(buffer));
    } catch (err) {
      console.error("[Transport] decode tile error:", err.message);
      return;
    }
    // Flush all tiles collected within one animation frame (single render pass)
    if (!this._rafRef) {
      this._rafRef = requestAnimationFrame(() => {
        this._rafRef = null;
        const tiles = this._tileBatch;
        this._tileBatch = [];
        if (tiles.length > 0) {
          this._emit("tiles-data", { tiles, timestamp: Date.now() });
        }
      });
    }
  }
}
