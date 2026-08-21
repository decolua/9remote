import { browserFetch } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { getHostFp2 } from "../../lib/hostKey.js";
import { headOf } from "./apiKey.js";
import { setActivePairing } from "../../lib/pairingCode.js";

const logger = createLogger("session");
const TEMP_KEY_EXPIRY_MINUTES = 10;

/**
 * Create temp key on Worker for API key, appended with the host-key fp2.
 * The returned { tempKey, oneTimeKey, expiresAt } carries both the bare
 * 6-char tempKey (what clients send to the Worker) and the full pairing
 * code "TEMPKEY-FP2" (what the user sees / what rides the QR fragment).
 * @param {string} apiKey - API key
 * @param {string} workerUrl - Worker URL
 * @returns {Promise<{tempKey: string, oneTimeKey: string, expiresAt: number} | null>}
 */
export async function createTempKey(apiKey, workerUrl) {
  try {
    const response = await browserFetch(`${workerUrl}/api/temp-key/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: headOf(apiKey),
        expiryMinutes: TEMP_KEY_EXPIRY_MINUTES
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const fp2 = getHostFp2();
    setActivePairing(data.tempKey, fp2, data.expiresAt);
    // No separator: the code is read and typed as one 8-char token (6 tempKey + 2 fp2)
    return { ...data, oneTimeKey: `${data.tempKey}${fp2}` };
  } catch (error) {
    // logger, not console: the TUI clears the screen and the reason would be lost
    logger.error(`Temp key creation failed: ${error?.message || error}`);
    return null;
  }
}

/** Connect URL for a pairing code.
 *
 *  The whole code (tempKey + fp2) rides the FRAGMENT so it never reaches the
 *  server — the fp2 must stay unknown to the Worker for the pairing check to
 *  mean anything.
 *
 *  ?k= repeats just the tempKey for one reason: a web build that predates the
 *  fragment support reads only the query, and it sends that value to the Worker
 *  verbatim (no trimming), so it must see the bare 6-char key. Drop this once
 *  every client is on a build that parses the fragment. */
export function connectUrlOf(workerUrl, data) {
  if (!data?.tempKey) return `${workerUrl}/login`;
  return `${workerUrl}/login?k=${data.tempKey}#${data.oneTimeKey}`;
}

/**
 * Register (or refresh) the session row for a key. A key with no session row
 * resolves no tunnel, so every login with it fails — regenerating a key must
 * register it before the old one is replaced.
 * Only the HEAD is sent; the TAIL never reaches the Worker.
 * @returns {Promise<boolean>} true when the Worker accepted the key
 */
export async function registerSession(apiKey, workerUrl, tunnelUrl, previousKey) {
  try {
    const res = await browserFetch(`${workerUrl}/api/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: headOf(apiKey) })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Carry the live tunnel over to the new key, else clients resolve nothing
    // until the next urlSync tick.
    if (tunnelUrl) {
      await browserFetch(`${workerUrl}/api/session/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: headOf(apiKey), tunnelUrl })
      }).catch(() => {});
    }
    // Retire the replaced key only after the new one is live — a regenerated
    // key must actually revoke the old one, and leaving the row behind would
    // keep it usable (and pile up rows per machine).
    if (previousKey && headOf(previousKey) !== headOf(apiKey)) {
      await browserFetch(`${workerUrl}/api/session/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: headOf(previousKey) })
      }).catch(() => {});
    }
    return true;
  } catch (error) {
    logger.error(`Session registration failed: ${error?.message || error}`);
    return false;
  }
}
