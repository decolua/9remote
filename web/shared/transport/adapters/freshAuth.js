import { getTrust } from "@/shared/transport/lib/deviceTrust";
import { sealTail } from "@/shared/transport/lib/tailSeal";

/**
 * Handshake auth for one connect attempt.
 *
 * The key TAIL admits a device, and it goes to the agent here. Neither carrier
 * is this project's server — the tunnel terminates on the user's own machine
 * and RTC is peer to peer — and it deliberately never rides the DO signaling
 * relay, which IS ours.
 *
 * But "not our server" is not the same as "nobody's": the tunnel is a path, and
 * whoever holds a path reads what crosses it. So when the agent's sealing key
 * has been pinned — anchored by the fp2 the user read off its screen — the tail
 * is encrypted to it and only the agent can open it. Without a pinned key there
 * is nothing to seal to and it travels as before; the agent accepts either.
 *
 * Built per attempt rather than once: socket.io reconnects on its own (phone
 * sleeps, network flaps) and the trust store can gain a TAIL in between (an
 * enrollment completing mid-session), so a value captured at mount goes stale.
 *
 * No TAIL held (v1 key, pre-split pairing) means the field is simply absent and
 * the agent applies its legacy path.
 */
export async function freshAuth(baseAuth = {}, connectionMode) {
  const auth = { ...baseAuth, connectionMode };
  // A one-time login holds the CODE's tail, filed under the code; an API key
  // login holds the key's, filed under its HEAD.
  //
  // Chosen by which entry actually HAS a tail, not by which exists: a browser
  // that logged in before has a trust entry under the HEAD carrying a pinned
  // host key and no tail, and preferring that one left a pairing device unable
  // to present the code it was holding all along.
  const byKey = getTrust(baseAuth.apiKey);
  const byCode = baseAuth.tempKey ? getTrust(baseAuth.tempKey) : null;
  const trust = byKey?.tail ? byKey : (byCode?.tail ? byCode : byKey || byCode);
  const tail = trust?.tail;

  delete auth.keyTail;
  delete auth.keyTailSealed;
  if (!tail) return auth;

  if (trust?.hostSealKey) {
    const sealed = await sealTail(tail, trust.hostSealKey);
    if (sealed) {
      auth.keyTailSealed = sealed;
      return auth;
    }
    // Sealing failed — a browser without X25519, or a stored key that no longer
    // imports. The tail still has to reach the agent for this device to connect.
  }
  auth.keyTail = tail;
  return auth;
}
