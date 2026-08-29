import { ADAPTER_STATE } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

const OTHER_ROLE = { agent: "client", client: "agent" };

// Reconnect backoff — mirrors WsProtocol retry cadence (exp, capped).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Cap failures that happen BEFORE the first successful open: an unreachable DO
// (bad apiKey → 401, wrong URL) never opens, so without a cap we'd retry forever.
// A transient network blip recovers within this many attempts.
const MAX_PRE_OPEN_FAILURES = 5;
// retryNow() is driven by visibilitychange / resume / network-change, which fire
// in bursts on mobile (a single app switch can trigger all three). Each accepted
// call costs a fresh WS upgrade, and every upgrade runs the DO's session gate —
// one D1 read. Collapse a burst into a single attempt.
const RETRY_NOW_THROTTLE_MS = 3000;
// A bus that has been handshaking longer than this is presumed wedged, so
// replacing it is worth another upgrade. Below it, let the handshake finish.
const HANDSHAKE_STALL_MS = 5000;

function sigData(msg) {
  // Mirror of the agent client: answers carry pub/sig (host-key signature)
  if (msg.type === "offer") return { sdp: msg.sdp };
  if (msg.type === "answer") return { sdp: msg.sdp, pub: msg.pub, xpub: msg.xpub, sig: msg.sig };
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
    this._lastRetryNowAt = 0;
    this._connectingSince = 0;
    this._retryNowTimer = null;
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
      return false; // bus closing between the ready check and send
    }
  }

  on(handler) { this._handler = handler; }
  off() { this._handler = null; }

  /** Network changed — retry now instead of waiting out the backoff, and clear
   * the pre-open cap so a relay abandoned on the old network gets a fresh start. */
  retryNow(reason = "?") {
    if (this._closed || this.ready) return;

    const now = Date.now();
    // Burst guard. Without it, visibility + resume + network-change on one app
    // switch each tore down the in-flight bus and opened another.
    //
    // Deferred, never dropped: after MAX_PRE_OPEN_FAILURES the close handler stops
    // scheduling, leaving retryNow as the only way back. Discarding a throttled
    // call could therefore strand the relay until some later event happened to
    // fire — so the burst collapses into one attempt at the end of the window.
    const sinceLast = now - this._lastRetryNowAt;
    if (sinceLast < RETRY_NOW_THROTTLE_MS) {
      termLog("switch", `sig retryNow DEFER by=${reason} (throttled)`);
      this._scheduleRetryNow(RETRY_NOW_THROTTLE_MS - sinceLast, reason);
      return;
    }

    // A handshake that started moments ago is most likely the retry a previous
    // caller already triggered — let it finish rather than restarting it. Only a
    // stalled one is worth replacing.
    if (this._state === ADAPTER_STATE.connecting
        && now - this._connectingSince < HANDSHAKE_STALL_MS) {
      termLog("switch", `sig retryNow DEFER by=${reason} (handshake ${now - this._connectingSince}ms old)`);
      this._scheduleRetryNow(HANDSHAKE_STALL_MS - (now - this._connectingSince), reason);
      return;
    }

    termLog("switch", `sig retryNow GO by=${reason}`);
    this._lastRetryNowAt = now;
    this._attempt = 0;
    this._preOpenFails = 0;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    // A bus still handshaking is bound to the old network — drop it, else
    // _open() leaves two sockets racing and _onClose reschedules a duplicate.
    const stale = this._ws;
    this._ws = null;
    try { stale?.close(); } catch {}
    this._open();
  }

  /** One pending re-check per client — repeated calls inside the window collapse
   * onto the timer already armed instead of stacking up. */
  _scheduleRetryNow(delay, reason = "?") {
    if (this._retryNowTimer) return;
    this._retryNowTimer = setTimeout(() => {
      this._retryNowTimer = null;
      this.retryNow(`${reason}-deferred`);
    }, delay);
  }

  disconnect() {
    this._closed = true;
    this._stopPing();
    clearTimeout(this._retryNowTimer);
    this._retryNowTimer = null;
    clearTimeout(this._reconnectTimer);
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this._setState(ADAPTER_STATE.closed);
  }

  _open() {
    this._setState(ADAPTER_STATE.connecting);
    this._connectingSince = Date.now();
    const ws = new WebSocket(this._url);
    this._ws = ws;
    ws.addEventListener("open", () => {
      this._attempt = 0;
      this._preOpenFails = 0;
      this._openedOnce = true;
      this._setState(ADAPTER_STATE.open);
      this._startPing();
      debugLog("transport", `[sig] ${this._role} connected room=${this._roomId}`);
      termLog("switch", `sig open (after ${this._attempt} retries)`);
      this._onReady?.();
    });
    ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      debugLog("transport", `[sig] recv ${msg.type} from=${msg.from}`);
      this._handler?.({ type: msg.type, from: msg.from, ...msg.payload });
    });
    // Guard: a bus replaced by retryNow() must not drive reconnect state.
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
        termLog("switch", `sig GAVE UP (${this._preOpenFails - 1} pre-open failures) — retryNow is the only way back`);
        return;
      }
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._attempt++;
    // Jitter de-syncs a fleet of clients retrying after the same outage (thundering herd)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this._attempt - 1), RECONNECT_MAX_MS) + Math.random() * RECONNECT_BASE_MS;
    debugLog("transport", `[sig] ${this._role} reconnect in ${delay}ms (attempt ${this._attempt})`);
    termLog("switch", `sig reconnect in ${Math.round(delay)}ms (attempt ${this._attempt})`);
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
