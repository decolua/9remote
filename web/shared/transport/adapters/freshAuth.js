import { getTrust } from "@/shared/transport/lib/deviceTrust";

/**
 * Handshake auth for one connect attempt.
 *
 * Carries the key TAIL straight to the agent. The tunnel is a Cloudflare Tunnel
 * to the user's own machine — not this project's Worker — so the TAIL is not
 * handed to the signaling server by travelling here. It deliberately does NOT
 * ride the DO signaling relay, which IS ours.
 *
 * Built per attempt rather than once: socket.io reconnects on its own (phone
 * sleeps, network flaps) and the trust store can gain a TAIL in between (an
 * enrollment completing mid-session), so a value captured at mount goes stale.
 *
 * No TAIL held (v1 key, pre-split pairing) means the field is simply absent and
 * the agent applies its legacy path.
 */
export function freshAuth(baseAuth = {}, connectionMode) {
  const auth = { ...baseAuth, connectionMode };
  const tail = getTrust(baseAuth.apiKey)?.tail;
  if (tail) auth.keyTail = tail;
  else delete auth.keyTail;
  return auth;
}
