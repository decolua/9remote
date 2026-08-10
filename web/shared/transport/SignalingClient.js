import { ADAPTER_STATE } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";

const OTHER_ROLE = { agent: "client", client: "agent" };

// Reconnect backoff — mirrors WsProtocol retry cadence (exp, capped).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Cap failures that happen BEFORE the first successful open: an unreachable DO
// (bad apiKey → 401, wrong URL) never opens, so without a cap we'd retry forever.
// A transient network blip recovers within this many attempts.
const MAX_PRE_OPEN_FAILURES = 5;

function sigData(msg) {
  if (msg.type === "offer" || msg.type === "answer") return { sdp: msg.sdp };
  if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
  return msg; // error → {message}
}

/**
 * SignalingClient — browser-side WS relay to the signaling Durable Object.
 * One instance per role per room. Outbound: {to, type, payload}. Inbound: {type, ...payload}.
 * Keepalive "ping" is auto-replied by the DO runtime (Hibernation — never wakes, never billed).
 * Auto-reconnects with exponential backoff (mirrors WsProtocol pattern).
 */
export class SignalingClient {
  static id = "sig";

  constructor({ url, role, roomId, apiKey, from, onReady, pingMs = 25000 }) {
    const peerId = from || role;
    this._url = `${url}/ws/${encodeURIComponent(roomId)}?role=${role}&apiKey=${encodeURIComponent(apiKey)}&from=${encodeURIComponent(peerId)}`;
    this._from = from || role;
    this._onReady = onReady || null;
    this._role = role;
    this._roomId = roomId;
    this._pingMs = pingMs;
    this._ws = null;
    this._handler = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._attempt = 0;
    this._preOpenFails = 0;
    this._openedOnce = false;
    this._closed = false;     // intentional disconnect — stops reconnect
    this._state = ADAPTER_STATE.idle;
  }

  get ready() { return this._ws?.readyState === 1; } // OPEN

  connect() {
    this._closed = false;
    this._open();
  }

  send(msg) {
    debugLog("transport", `[sig] send ${msg.type} ready=${this.ready}`);
    if (!this.ready) return false;
    try {
      // msg.to addresses a specific peer (agent → one of many clients); the
      // opposite role is the default (client → the room's single agent).
      this._ws.send(JSON.stringify({ to: msg.to || OTHER_ROLE[this._role], from: this._from, type: msg.type, payload: sigData(msg) }));
      return true;
    } catch {
      return false; // socket closing between the ready check and send
    }
  }

  on(handler) { this._handler = handler; }
  off() { this._handler = null; }

  /** Network changed — retry now instead of waiting out the backoff, and clear
   * the pre-open cap so a relay abandoned on the old network gets a fresh start. */
  retryNow() {
    if (this._closed || this.ready) return;
    this._attempt = 0;
    this._preOpenFails = 0;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    // A socket still handshaking is bound to the old network — drop it, else
    // _open() leaves two sockets racing and _onClose reschedules a duplicate.
    const stale = this._ws;
    this._ws = null;
    try { stale?.close(); } catch {}
    this._open();
  }

  disconnect() {
    this._closed = true;
    this._stopPing();
    clearTimeout(this._reconnectTimer);
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this._setState(ADAPTER_STATE.closed);
  }

  _open() {
    this._setState(ADAPTER_STATE.connecting);
    const ws = new WebSocket(this._url);
    this._ws = ws;
    ws.addEventListener("open", () => {
      this._attempt = 0;
      this._preOpenFails = 0;
      this._openedOnce = true;
      this._setState(ADAPTER_STATE.open);
      this._startPing();
      debugLog("transport", `[sig] ${this._role} connected room=${this._roomId}`);
      this._onReady?.();
    });
    ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      debugLog("transport", `[sig] recv ${msg.type} from=${msg.from}`);
      this._handler?.({ type: msg.type, from: msg.from, ...msg.payload });
    });
    // Guard: a socket replaced by retryNow() must not drive reconnect state.
    ws.addEventListener("close", () => { if (this._ws === ws) this._onClose(); });
    ws.addEventListener("error", () => { if (this._ws === ws) this._onClose(); });
  }

  _onClose() {
    this._stopPing();
    this._ws = null;
    this._setState(ADAPTER_STATE.closed);
    if (this._closed) return;
    // Never opened = pre-handshake failure (bad apiKey, wrong URL, blocked).
    // Cap so a misconfigured relay doesn't spin forever; transient network
    // recovers within the cap and resets on success.
    if (!this._openedOnce) {
      this._preOpenFails++;
      if (this._preOpenFails > MAX_PRE_OPEN_FAILURES) {
        debugLog("transport", `[sig] ${this._role} giving up — ${this._preOpenFails - 1} pre-open failures`);
        return;
      }
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._attempt++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this._attempt - 1), RECONNECT_MAX_MS);
    debugLog("transport", `[sig] ${this._role} reconnect in ${delay}ms (attempt ${this._attempt})`);
    this._reconnectTimer = setTimeout(() => { if (!this._closed) this._open(); }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.ready) { try { this._ws.send("ping"); } catch {} }
    }, this._pingMs);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _setState(state) { this._state = state; }
}
