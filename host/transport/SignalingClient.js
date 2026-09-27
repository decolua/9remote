import { createLogger } from "../lib/logger.js";

const logger = createLogger("signaling");

const OTHER_ROLE = { agent: "client", client: "agent" };
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Cap failures before the first successful open — a misconfigured/unreachable DO
// (bad apiKey → 401) never opens; without this cap we'd retry forever.
const MAX_PRE_OPEN_FAILURES = 5;
// After giving up, retryNow() is the only way back — the host has no
// visibilitychange to lean on, so callers (a client connecting over the
// tunnel) drive it. Throttled so a burst of connections costs one attempt.
const RETRY_NOW_THROTTLE_MS = 3000;
// A WS upgrade that neither opens nor fails leaves no event to react to, so the
// relay would sit dead forever. Observed after a reconnect storm.
const HANDSHAKE_TIMEOUT_MS = 10000;

function sigData(msg) {
  // Answers carry the host-key signature (pub/sig) for client-side verification —
  // they must survive the relay envelope, not be flattened to {sdp}.
  if (msg.type === "offer") return { sdp: msg.sdp };
  if (msg.type === "answer") return { sdp: msg.sdp, pub: msg.pub, xpub: msg.xpub, sig: msg.sig };
  if (msg.type === "ice") return { candidate: msg.candidate, mid: msg.mid };
  return msg; // error → {message}
}

// Host-side mirror of web/shared/transport/SignalingClient.js.
// Uses Node 22 global WebSocket. DO runtime auto-replies to "ping" (Hibernation).
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
    this._ready = false;
    this._closed = false;
  }

  get ready() { return this._ready; }

  connect() {
    this._closed = false;
    this._open();
  }

  send(msg) {
    if (!this.ready) return false;
    try {
      // msg.to addresses a specific client peerId; role is the default target.
      this._ws.send(JSON.stringify({ to: msg.to || OTHER_ROLE[this._role], from: this._from, type: msg.type, payload: sigData(msg) }));
      return true;
    } catch {
      return false; // socket closing between the ready check and send
    }
  }

  on(handler) { this._handler = handler; }
  off() { this._handler = null; }

  disconnect() {
    this._closed = true;
    this._stopPing();
    clearTimeout(this._reconnectTimer);
    try { this._ws?.close(); } catch {}
    this._ws = null;
    this._ready = false;
  }

  _open() {
    // A pending retry must not fire on top of this attempt, and the socket it
    // would replace has to go: an abandoned-but-open socket keeps the room slot
    // while nothing reads from it.
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const previous = this._ws;
    this._ws = null;
    if (previous) { try { previous.close(); } catch {} }

    const ws = new WebSocket(this._url);
    this._ws = ws;
    // A socket that never opens, errors, or closes (silently dropped upgrade)
    // leaves nothing to drive reconnect — the relay would stay dead until the
    // process restarted. Bound the handshake instead.
    const stallTimer = setTimeout(() => {
      if (this._ws !== ws || this._closed) return;
      logger.debug(`${this._role} handshake stalled — retrying`);
      this._ws = null;
      try { ws.close(); } catch {}
      this._onClose(null, "handshake-stall");
    }, HANDSHAKE_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(stallTimer);
      this._ready = true;
      this._attempt = 0;
      this._preOpenFails = 0;
      this._openedOnce = true;
      this._startPing();
      logger.debug(`${this._role} connected room=${this._roomId}`);
      this._onReady?.();
    });
    ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handler?.({ type: msg.type, from: msg.from, ...msg.payload });
    });
    // Guard: failed connects fire error+close both — only one may drive reconnect,
    // else every failure doubles the retry timers (exponential storm).
    ws.addEventListener("close", (e) => { clearTimeout(stallTimer); if (this._ws === ws) this._onClose(e?.code, e?.reason); });
    ws.addEventListener("error", () => { clearTimeout(stallTimer); if (this._ws === ws) this._onClose(null, "error"); });
  }

  /** Network may be back (e.g. a client just reached us over the tunnel) —
   *  retry immediately and clear the pre-open cap, which otherwise strands the
   *  relay for the life of the process. Throttled: many clients may call this
   *  at once, and each accepted call costs a WS upgrade + a D1 read in the DO. */
  retryNow(reason = "?") {
    if (this._closed || this._ws) {
      logger.debug(`retryNow skip by=${reason} (${this._closed ? "closed" : "socket already up"})`);
      return;
    }
    const now = Date.now();
    if (now - (this._lastRetryNowAt || 0) < RETRY_NOW_THROTTLE_MS) {
      logger.debug(`retryNow throttled by=${reason}`);
      return;
    }
    logger.debug(`retryNow go by=${reason} (was attempt ${this._attempt}, preOpenFails ${this._preOpenFails})`);
    this._lastRetryNowAt = now;
    this._attempt = 0;
    this._preOpenFails = 0;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._open();
  }

  _onClose(code, why) {
    this._stopPing();
    this._ws = null;
    this._ready = false;
    if (this._closed) return;
    logger.debug(`${this._role} relay closed code=${code ?? "?"}${why ? ` (${why})` : ""} openedOnce=${this._openedOnce}`);
    if (!this._openedOnce) {
      this._preOpenFails++;
      if (this._preOpenFails > MAX_PRE_OPEN_FAILURES) {
        logger.warn(`${this._role} giving up — ${this._preOpenFails - 1} pre-open failures`);
        return;
      }
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._attempt++;
    // Jitter de-syncs a fleet of hosts retrying after the same outage (thundering herd)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this._attempt - 1), RECONNECT_MAX_MS) + Math.random() * RECONNECT_BASE_MS;
    logger.debug(`${this._role} reconnect in ${delay}ms (attempt ${this._attempt})`);
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
}
