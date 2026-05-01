import { WsProtocol } from "./WsProtocol.js";
import { WebRtcProtocol } from "./WebRtcProtocol.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";

/**
 * ProtocolManager — unified server transport per client connection.
 *
 * Strategy:
 *   - PRIMARY: WsProtocol (always active — control events + fallback tiles)
 *   - UPGRADE:  WebRtcProtocol (binary tiles, when enableWebRTC = true)
 *   - FALLBACK: auto-reverts to WS on DC fail/close
 *
 * Interface:
 *   emit(event, data)    — always WS (control events)
 *   sendTiles(payload)   — DC if ready + within limits, else WS fallback
 *   close()              — tear down DC peer
 */
export class ProtocolManager {
  /**
   * @param {object} socket — socket.io socket
   * @param {object} config
   * @param {boolean} config.enableWebRTC
   * @param {string|null} config.apiKey
   * @param {string|null} config.turnApiUrl
   * @param {number} config.turnRefreshInterval
   * @param {number} config.dcMaxMessageSize
   * @param {number} config.dcChunkSize
   * @param {number} config.dcMaxTilesPerFrame
   * @param {number} config.answerTimeout
   */
  constructor(socket, config) {
    this._ws = new WsProtocol(socket);
    this._rtc = null;
    this._wsChunkSize = config.wsChunkSize;

    if (config.enableWebRTC) {
      this._rtc = new WebRtcProtocol({
        socketId: socket.id,
        apiKey: config.apiKey || null,
        turnApiUrl: config.turnApiUrl || null,
        turnRefreshInterval: config.turnRefreshInterval,
        dcMaxMessageSize: config.dcMaxMessageSize,
        answerTimeout: config.answerTimeout
      });
      this._dcChunkSize = config.dcChunkSize;
      this._dcMaxTilesPerFrame = config.dcMaxTilesPerFrame;
    }
  }

  get type() { return this._rtc?.isReady() ? "dc" : "ws"; }

  /** Initialize — fetch TURN credentials if needed */
  async init() {
    await this._rtc?.init();
  }

  /** Setup WebRTC signaling listeners on the socket */
  setupSignaling(socket) {
    this._rtc?.setupSignaling(socket);
  }

  /** Always WS — control/meta events */
  emit(event, data) {
    this._ws.emit(event, data);
  }

  /**
   * Send tiles: via DC if ready and within limits, else WS fallback.
   * encodeTilesBatch is passed in so ProtocolManager stays encoding-agnostic.
   *
   * @param {object} payload        — { tiles, timestamp, ...meta }
   * @param {Function} encodeBatch  — (tiles, timestamp) => Buffer
   */
  sendTiles(payload, encodeBatch) {
    const { tiles } = payload;
    if (this._rtc?.isReady() && tiles?.length > 0 && encodeBatch) {
      const frameTs = payload.timestamp ?? Date.now();
      const chunks = [];
      for (let i = 0; i < tiles.length; i += this._dcChunkSize) {
        chunks.push(encodeBatch(tiles.slice(i, i + this._dcChunkSize), frameTs));
      }
      this._rtc.sendBinary(chunks);
      return;
    }
    this._emitTilesChunked(payload);
  }

  /**
   * Split tiles into smaller batches before WS emit.
   * Socket.IO binary packet grows with number of Buffer placeholders;
   * too many tiles in one emit causes client-side parse error.
   */
  /**
   * Binary pack path — encode tiles to single Buffer per chunk and emit as
   * "tiles-data-binary". Each WS packet carries exactly 1 binary attachment,
   * avoiding the multi-attachment parser issue with socket.io-client.
   * Metadata (hashes, changedIndices) travels in a separate "tiles-meta" event.
   */
  _emitTilesChunked(payload) {
    const { tiles, timestamp } = payload;
    const list = tiles || [];
    if (list.length === 0) return;
    const size = this._wsChunkSize;
    const frameTs = timestamp ?? Date.now();
    for (let i = 0; i < list.length; i += size) {
      const chunk = list.slice(i, i + size);
      this._ws.emit("tiles-bin-v2", encodeTilesBatch(chunk, frameTs));
    }
  }

  /** Tear down WebRTC peer */
  close() {
    this._rtc?.close();
  }
}
