// Process-wide signaling client — host joins the DO room ONCE at server start
// (room = apiKey), independent of any socket.io connection. This breaks the
// circular dep where signaling only worked after a tunnel carried socket.io.
//
// Per-socket ProtocolManagers register an inbound handler keyed by the client
// deviceId they serve. Offers that arrive before a PM has registered (client
// connected via DO faster than the tunnel brought socket.io up) are buffered per
// deviceId and flushed when the matching PM registers — so the first offer is
// never lost to a race.
import { SignalingClient } from "../transport/SignalingClient.js";
import { WORKER_URL } from "../cli/config.js";
import { createLogger } from "./logger.js";

const logger = createLogger("signaling");

let _client = null;
// deviceId(client) → inbound handler (the PM serving that client)
const _handlers = new Map();
// deviceId(client) → buffered messages (offer + trickled ICE) that arrived
// before the PM registered. Order preserved so the offer is applied first.
const _pendingOffers = new Map();
const MAX_PENDING_PER_DEVICE = 64;
// Any DO peer holding a valid apiKey can open a room and send offers under a
// fresh peerId each time. Cap distinct buffered peers so an unapproved device
// can't grow the buffer map without bound (each entry holds an SDP).
const MAX_PENDING_PEERS = 32;
// Listeners fired once the DO connection opens (PMs use it to flush sig buffers)
const _readyListeners = new Set();
// Called when an offer arrives with no PM registered — creates an RTC-only
// session so a client can connect before the tunnel brings socket.io up.
let _offerFallback = null;

export function setOfferFallback(fn) { _offerFallback = fn; }

export function onSignalingReady(fn) {
  // Already connected (global started before this PM registered) — fire immediately.
  if (_client?.ready) { try { fn(); } catch (e) { logger.error(`ready listener: ${e.message}`); } }
  _readyListeners.add(fn);
  return () => { _readyListeners.delete(fn); };
}

// Idempotent for the same key. When the key CHANGES (user regenerated it) the
// old room is abandoned and we rejoin under the new one — otherwise the host
// keeps listening on the retired room while clients that hold the new key sit
// in a room nobody answers, spinning forever.
let _roomKey = null;

export function initSignalingGlobal(apiKey) {
  if (!apiKey) return;
  if (_client) {
    if (_roomKey === apiKey) return;
    logger.info(`apiKey changed — rejoining signaling room ${apiKey.slice(0, 8)}...`);
    stopSignalingGlobal();
  }
  _roomKey = apiKey;
  const doUrl = WORKER_URL.replace(/^http/, "ws") + "/signaling";
  _client = new SignalingClient({
    url: doUrl, role: "agent", roomId: apiKey, apiKey,
    onReady: () => { for (const fn of _readyListeners) { try { fn(); } catch (e) { logger.error(`ready listener: ${e.message}`); } } }
  });
  _client.on((msg) => {
    const handler = _handlers.get(msg.from);
    if (handler) {
      if (msg.type === "offer") logger.debug(`offer from ${msg.from?.slice(0, 8)} → PM`);
      try { handler(msg); } catch (e) { logger.error(`signaling handler: ${e.message}`); }
      return;
    }
    // No PM yet (socket.io not connected for this client). Buffer offer + the
    // ICE that trickles right behind it, then ask the transport server to spin
    // an RTC-only session; onSignalingMessage flushes the queue in order.
    // ICE arriving with no offer buffered is orphaned — nothing to attach to.
    if (msg.type !== "offer" && !_pendingOffers.has(msg.from)) return;
    // Evict the oldest peer (Map keeps insertion order) rather than reject the
    // newest — a legit client retrying must still get through.
    if (!_pendingOffers.has(msg.from) && _pendingOffers.size >= MAX_PENDING_PEERS) {
      const oldest = _pendingOffers.keys().next().value;
      _pendingOffers.delete(oldest);
      logger.warn(`pending buffer full — evicted ${oldest?.slice(0, 8)}`);
    }
    const queue = _pendingOffers.get(msg.from) || [];
    if (msg.type === "offer") queue.length = 0; // re-offer supersedes stale ICE
    if (queue.length < MAX_PENDING_PER_DEVICE) queue.push(msg);
    _pendingOffers.set(msg.from, queue);
    if (msg.type !== "offer") return;
    logger.debug(`offer from ${msg.from?.slice(0, 8)} — no PM, spawning RTC session`);
    try { _offerFallback?.(msg.from); } catch (e) { logger.error(`offer fallback: ${e.message}`); }
  });
  _client.connect();
  logger.info(`global signaling client started (room=${apiKey.slice(0, 8)}...)`);
}

// Register the PM handler for a specific client deviceId. Flushes any offer that
// arrived while the tunnel was still bringing socket.io up.
export function onSignalingMessage(deviceId, handler) {
  if (!deviceId) return () => {};
  _handlers.set(deviceId, handler);
  const pending = _pendingOffers.get(deviceId);
  if (pending?.length) {
    _pendingOffers.delete(deviceId);
    logger.debug(`flushing ${pending.length} pending signal(s) for ${deviceId.slice(0, 8)}`);
    for (const msg of pending) {
      try { handler(msg); } catch (e) { logger.error(`flush pending: ${e.message}`); }
    }
  }
  return () => { if (_handlers.get(deviceId) === handler) _handlers.delete(deviceId); };
}

export function sendSignaling(msg) {
  return _client?.send(msg) || false;
}

// Discard a buffered offer (device rejected — nothing will ever consume it).
export function dropPending(peerId) {
  _pendingOffers.delete(peerId);
}

// Every buffered peer of a device ("deviceId:tab") — approval is per device, so
// approving one must release all tabs waiting behind it.
export function pendingPeersOf(deviceId) {
  if (!deviceId) return [];
  return [..._pendingOffers.keys()].filter((p) => p.split(":")[0] === deviceId);
}

/** A client just reached us (so the network is back) — revive a relay that hit
 *  its pre-open cap. No-op when it is already connected or was never started. */
export function retrySignalingNow(reason = "?") {
  try { _client?.retryNow?.(reason); } catch (e) { logger.warn(`retrySignalingNow: ${e.message}`); }
}

export function isSignalingReady() {
  return !!_client?.ready;
}

// Is an RTC offer buffered for this peer (arrived before a PM existed)? Used by the
// WS connection handler to wait for the in-flight RTC session instead of building a
// second PM (which would duplicate output to the same client).
export function hasPendingOffer(peerId) {
  if (!peerId) return false;
  return _pendingOffers.has(peerId);
}

// Snapshot for the UI transport badges
export function getSignalingState() {
  return { started: !!_client, ready: !!_client?.ready };
}

export function stopSignalingGlobal() {
  try { _client?.disconnect(); } catch {}
  _client = null;
  _roomKey = null;
  _handlers.clear();
  _pendingOffers.clear();
}
