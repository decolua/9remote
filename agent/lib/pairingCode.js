// Active pairing window — the one-time code currently displayed for pairing.
// Enrollment (device:enroll) is only valid while a code is live, and a wrong
// fp2 presentation burns attempts: 3 fails kill the code (blind-guess MITM
// gets ~3 shots at 1/1024 per code, each failure visible to the user).
//
// State is FILE-backed, not module memory: the CLI process (TUI/display)
// creates the code, the spawned server process validates enrollments —
// they only share the filesystem.
import { join } from "path";
import { PATHS } from "./constants.js";
import { createLogger } from "./logger.js";
import { writeJsonAtomic, readJsonSafe } from "./atomicFile.js";

const logger = createLogger("pairing");
const MAX_FP2_FAILS = 3;
const PAIRING_FILE = join(PATHS.STATE, "pairing.json");

// { tempKey, fp2, expiresAt, fp2Fails }
function readState() {
  const s = readJsonSafe(PAIRING_FILE, null);
  if (!s || Date.now() > s.expiresAt) return null;
  return s;
}

function writeState(state) {
  try {
    writeJsonAtomic(PAIRING_FILE, state);
  } catch (err) {
    logger.error(`persist pairing state: ${err.message}`);
  }
}

export function setActivePairing(tempKey, fp2, expiresAt) {
  writeState({ tempKey, fp2, expiresAt, fp2Fails: 0 });
}

export function clearActivePairing() {
  writeState({ tempKey: null, fp2: null, expiresAt: 0, fp2Fails: MAX_FP2_FAILS });
}

export function getActivePairing() {
  const s = readState();
  return s ? { tempKey: s.tempKey, fp2: s.fp2, expiresAt: s.expiresAt } : null;
}

// Returns true when the presented fp2 matches the live code's fp2. A miss is
// counted; MAX fails invalidate the code entirely.
export function validatePairingFp2(fp2) {
  const s = readState();
  if (!s) return false;
  if (fp2 === s.fp2) {
    if (s.fp2Fails > 0) writeState({ ...s, fp2Fails: 0 });
    return true;
  }
  // A wrong fp2 means the client is talking to a host whose key is not the one
  // printed on this code — a relay in the middle, or a stale/foreign code.
  // Either way this code is compromised: burn it immediately rather than
  // letting the presenter retry. (MAX_FP2_FAILS is kept at 1 by that logic;
  // the counter stays so the log shows how it died.)
  const fails = (s.fp2Fails || 0) + 1;
  logger.warn(`pairing fp2 mismatch (${fails}) — killing the code, possible MITM`);
  clearActivePairing();
  return false;
}
