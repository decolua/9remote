import { CONNECTION_STATE } from "../lib/connectionConstants.js";
import { ADMISSION, TAIL_REJECT_REASON } from "../lib/transportConstants.js";

/**
 * What happens to a connection when a carrier shows up — the whole admission
 * flow, with nothing transport-specific in it.
 *
 * This used to live inline in two places (the socket.io connection handler and
 * the RTC offer handler), which is why a rule added to one kept going missing
 * from the other. Here it is one function over a Connection and a verdict, so
 * both carriers — and any protocol added later — get the same answer and the
 * same consequences.
 *
 * It decides; it does not act. The caller performs the effects, which keeps
 * "what should happen" testable without a socket, a peer connection, or a
 * running host.
 *
 * @param {Connection} conn
 * @param {{step: "auth"|"authz", decision: string, reason?: string}} verdict
 *        from lib/deviceAuth.admissionGate
 * @returns {{
 *   effects: Array<"open-auth-channel"|"ask-host"|"start-session"|"refuse">,
 *   reason?: string
 * }}
 */
export function planAdmission(conn, verdict) {
  if (!conn || conn.closed) return { effects: [] };

  // Refused: the key is wrong, or the host said no. Same consequence either
  // way — the device does not get in, and no later click can change that.
  if (verdict.decision === ADMISSION.reject) {
    return { effects: ["refuse"], reason: verdict.reason || TAIL_REJECT_REASON.mismatch };
  }

  // Waiting on the KEY. Not a refusal: the proof travels over the very channel
  // this opens, so closing here would leave the device unable to ever prove
  // itself — the deadlock that made an RTC-first client retry forever.
  if (verdict.decision === ADMISSION.hold && verdict.step === "auth") {
    return conn.state === CONNECTION_STATE.authenticating
      ? { effects: ["open-auth-channel"], reason: verdict.reason }
      : { effects: [], reason: verdict.reason };
  }

  // Key proven. Record it before anything else looks at the connection, so the
  // host is only ever asked about a device whose key already checks out.
  if (conn.state === CONNECTION_STATE.authenticating) conn.keyProven();

  // Waiting on the HOST. Ask once per device — a second tab, or the device's
  // other carrier, joins the request that is already up.
  if (verdict.decision === ADMISSION.hold) {
    return { effects: ["ask-host"], reason: verdict.reason };
  }

  // Admitted: both gates passed. Starting is idempotent, so a carrier that
  // arrives after the conn is live simply attaches.
  if (conn.state === CONNECTION_STATE.awaitingHost) conn.hostAllowed();
  return { effects: conn.active ? ["start-session"] : [] };
}
