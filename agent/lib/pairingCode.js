// Active pairing window — the one-time code currently displayed, and the TAIL
// that belongs to it.
//
// A one-time code carries its own TAIL, generated fresh when the code is: both
// halves live and die together, so an expired code takes its secret with it.
// That is the only difference from an API key, whose TAIL is minted once and
// lasts as long as the key. Everything downstream — presenting it, proving it,
// refusing a wrong one — is the same code for both.
//
// A wrong TAIL burns attempts: 3 misses kill the code, so a blind guesser gets
// three shots at a fresh secret and the user sees every failure.
//
// State is FILE-backed, not module memory: the CLI process (TUI/display)
// creates the code, the spawned server process validates enrollments — they
// only share the filesystem.
import crypto from "crypto";
import { join } from "path";
import { PATHS } from "./constants.js";
import { createLogger } from "./logger.js";
import { writeJsonAtomic, readJsonSafe } from "./atomicFile.js";
import { browserFetch } from "./constants.js";

const logger = createLogger("pairing");
const PAIRING_FILE = join(PATHS.STATE, "pairing.json");

// Read off the agent's own screen and typed back. Short on purpose — it is
// read aloud and typed by hand — which is exactly why a miss has to be
// expensive: one wrong presentation kills the code outright, so a guesser gets
// a single attempt and then faces a fresh secret. No characters a user can
// misread.
// Upper case to match the code it rides with: the pair is shown together on
// the agent's screen and read back as one string, so a lower-case half looks
// like a different kind of thing. Case is presentation only — the comparison
// below folds it, because a user typing what they see should not have to
// reproduce it exactly.
const TAIL_CHARS = "ABCDEFGHIJKLMNPQRSTUVWXYZ123456789";
const TAIL_LENGTH = 2;

/** A fresh TAIL for a new one-time code. */
export function generatePairingTail() {
  let s = "";
  for (let i = 0; i < TAIL_LENGTH; i++) s += TAIL_CHARS[crypto.randomInt(TAIL_CHARS.length)];
  return s;
}

// { tempKey, tail, expiresAt }
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
  // workerUrl rides along so a code killed here can be revoked at the Worker
  // too: leaving it there would let the routing half keep resolving after the
  // secret half is gone.
  writeState({ tempKey, tail, expiresAt, workerUrl });
}

export function clearActivePairing() {
  writeState({ tempKey: null, tail: null, expiresAt: 0, workerUrl: null });
}

/**
 * Revoke a burnt code at the Worker as well as here.
 *
 * A one-time code is two halves: the tempKey the Worker routes by, and the TAIL
 * only this machine knows. Killing the TAIL locally stops the code admitting
 * anyone, but the tempKey would go on resolving until its own expiry — so the
 * guess that burnt it would still cost the user a live routing entry. Best
 * effort: the code is already dead locally either way.
 */
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

/**
 * Does this presentation match the live code's TAIL?
 *
 * Constant-time, and a single miss invalidates the code: guessing costs the
 * attacker the code itself, on the first try.
 */
export function matchesPairingTail(tail) {
  const s = readState();
  if (!s?.tail || !tail) return false;

  // Case-folded: the user is copying characters off a screen, and which case
  // they arrive in says nothing about whether they read them correctly. Codes
  // minted before this change are lower case, so both sides are folded rather
  // than only the input.
  const a = Buffer.from(String(tail).toUpperCase(), "utf8");
  const b = Buffer.from(String(s.tail).toUpperCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Spend the attempt: compare, and kill the code if it did not match.
 *
 * Deliberately separate from matchesPairingTail, which only looks. The
 * admission gate is asked the same question several times per connection —
 * once per carrier, again on every re-entry — and with one strike to give, a
 * comparison that also burns the code would let the FIRST of those calls
 * destroy a code the user typed correctly on another carrier.
 *
 * So looking is free and unlimited; burning happens once, where a device
 * actually submits a proof.
 */
export function consumePairingTail(tail) {
  if (matchesPairingTail(tail)) return true;

  const s = readState();
  // Nothing presented, or no live code to present against. Neither is a wrong
  // guess, and with one strike to give, treating them as one would let any
  // connection — an RTC carrier that has not sent its proof yet, a client with
  // no code at all — destroy a pairing the user is halfway through.
  if (!s || !tail) return false;

  // One strike. The code is copied off the agent's own screen, so a mismatch is
  // either a typo — and making a new code costs a keystroke — or somebody
  // guessing, who now gets a single shot. Killed here AND at the Worker, so a
  // dead code cannot even be redeemed for routing.
  clearActivePairing();
  logger.warn("pairing tail mismatch — code killed here and at the Worker");
  revokeAtWorker(s.tempKey, s.workerUrl); // not awaited: the code is dead already
  return false;
}
