// Active pairing window — file-backed one-time code and tail.
import crypto from "crypto";
import { join } from "path";
import { PATHS } from "./constants.js";
import { createLogger } from "./logger.js";
import { writeJsonAtomic, readJsonSafe } from "./atomicFile.js";
import { browserFetch } from "./constants.js";

const logger = createLogger("pairing");
const PAIRING_FILE = join(PATHS.STATE, "pairing.json");

// Uppercase alphanumeric chars (excluding confusing characters) for pairing tail.
const TAIL_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
const TAIL_LENGTH = 2;

/** A fresh TAIL for a new one-time code. */
export function generatePairingTail() {
  let s = "";
  for (let i = 0; i < TAIL_LENGTH; i++) s += TAIL_CHARS[crypto.randomInt(TAIL_CHARS.length)];
  return s;
}

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

export function setActivePairing(tempKey, tail, expiresAt, workerUrl = null) {
  writeState({ tempKey, tail, expiresAt, workerUrl });
}

export function clearActivePairing() {
  writeState({ tempKey: null, tail: null, expiresAt: 0, workerUrl: null });
}

/** Revoke pairing code at the Worker. */
async function revokeAtWorker(tempKey, workerUrl) {
  if (!tempKey || !workerUrl) return;
  try {
    await browserFetch(`${workerUrl}/api/temp-key/remove`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tempKey })
    });
    logger.info(`one-time code revoked at the Worker: ${tempKey}`);
  } catch (err) {
    logger.warn(`could not revoke the code at the Worker: ${err.message}`);
  }
}

export function getActivePairing() {
  const s = readState();
  return s ? { tempKey: s.tempKey, tail: s.tail, expiresAt: s.expiresAt } : null;
}

/** Constant-time comparison for pairing tail (case-insensitive). */
export function matchesPairingTail(tail) {
  const s = readState();
  if (!s?.tail || !tail) return false;

  const a = Buffer.from(String(tail).toUpperCase(), "utf8");
  const b = Buffer.from(String(s.tail).toUpperCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Check pairing tail; burn on mismatch only when the presenter named THIS code —
 *  a stale code's wrong tail must not kill the live pairing window. */
export function consumePairingTail(tail, presentedTempKey = null) {
  const s = readState();
  if (!s || !tail) return { match: false, burned: false };
  if (matchesPairingTail(tail)) return { match: true, burned: false };

  const namedThisCode = !presentedTempKey
    || String(presentedTempKey).trim().toUpperCase() === String(s.tempKey).trim().toUpperCase();
  if (!namedThisCode) return { match: false, burned: false };

  clearActivePairing();
  logger.warn("pairing tail mismatch — code killed here and at the Worker");
  revokeAtWorker(s.tempKey, s.workerUrl);
  return { match: false, burned: true };
}
