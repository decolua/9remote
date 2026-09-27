import { getTrust } from "@/shared/transport/lib/deviceTrust";
import { sealTail } from "@/shared/transport/lib/tailSeal";

/**
 * Handshake auth for one connect attempt.
 *
 * The key TAIL admits a device, and it goes to the host here. Neither carrier
 * is this project's server — the tunnel terminates on the user's own machine
 * and RTC is peer to peer — and it deliberately never rides the DO signaling
 * relay, which IS ours.
 *
 * But "not our server" is not the same as "nobody's": the tunnel is a path, and
 * whoever holds a path reads what crosses it. So when the host's sealing key
 * has been pinned — anchored by the fp2 the user read off its screen — the tail
 * is encrypted to it and only the host can open it. Without a pinned key there
 * is nothing to seal to and it travels as before; the host accepts either.
 *
 * Built per attempt rather than once: socket.io reconnects on its own (phone
 * sleeps, network flaps) and the trust store can gain a TAIL in between (an
 * enrollment completing mid-session), so a value captured at mount goes stale.
 *
 * No TAIL held (v1 key, pre-split pairing) means the field is simply absent and
 * the host applies its legacy path.
 */
export async function freshAuth(baseAuth = {}, connectionMode) {
  const auth = { ...baseAuth, connectionMode };
  // A one-time login holds the CODE's tail, filed under the code; an API key
  // login holds the key's, filed under its HEAD.
  //
  // While a tempKey is attached the host judges every tail against the CODE's
  // (a pairing session), so the code's tail wins whenever there is one — a
  // browser that paired before carries the KEY's tail under the same HEAD, and
  // preferring it here handed the host the right tail for the wrong session,
  // which burned the code and kicked the user out. Without a tempKey the key's
  // tail is the only credential, and an entry with just a pinned host key (no
  // tail) never outranks the code being held.
  const byKey = getTrust(baseAuth.apiKey);
  const byCode = baseAuth.tempKey ? getTrust(baseAuth.tempKey) : null;
  const trust = byCode?.tail ? byCode : (byKey?.tail ? byKey : byKey || byCode);
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
    // imports. The tail still has to reach the host for this device to connect.
  }
  auth.keyTail = tail;
  return auth;
}
