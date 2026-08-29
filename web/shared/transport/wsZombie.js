// WS zombie detection — pure helper, no transport deps (unit-testable in isolation).
//
// After OS background suspension, socket.io's ping timer freezes; the bus
// keeps reporting connected=true even though the underlying transport is dead.
// This helper classifies a WS adapter as zombie when it LOOKS ready (so the
// normal retry path won't touch it) but hasn't delivered bytes for a long time.
//
// Kept side-effect-free so it can be imported and tested without the full app.
import { WS_ZOMBIE_MS } from "@/shared/constants/transport";

/**
 * @param {object} opts
 * @param {boolean} [opts.ready=true]  — adapter's ready flag (open bus).
 * @param {number}  [opts.lastInboundAt=0] — Date.now() of last ws-source inbound.
 * @param {number}  opts.now           — current Date.now().
 * @returns {boolean}
 */
export function isWsZombie({ ready = true, lastInboundAt = 0, now } = {}) {
  // An openly-down bus is handled by the normal retry path — the zombie probe
  // only targets sockets that still look alive (the dangerous silent case).
  if (!ready) return false;
  // No inbound recorded since PM constructed → nothing ever flowed → suspect.
  if (!lastInboundAt) return true;
  return (now - lastInboundAt) >= WS_ZOMBIE_MS;
}
