// Admission with a sealed tail, at the level decideAdmission actually sees it.
//
// The unit tests for sealing cover the crypto; these cover the wiring, which is
// where the mistakes that matter live: a sealed tail that opens but is not
// compared, a plain tail still accepted from a carrier that should not carry
// one, or a failed unseal that reads as "no tail presented" and falls through
// to the branch that admits.
// Run: node --test agent/test/sealedAdmission.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sealTailFor } from "../lib/tailSeal.js";
import { presentedTailOf } from "../lib/deviceAuth.js";

const host = crypto.generateKeyPairSync("x25519");
const HOST_PUB = host.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const TAIL = "mnpqrstu";

test("a sealed tail is what gets compared", () => {
  const auth = { keyTailSealed: sealTailFor(TAIL, HOST_PUB) };
  assert.equal(presentedTailOf(auth, (s) => (s ? TAIL : null)), TAIL);
});

test("a plain tail still works — RTC does not need sealing", () => {
  // The carrier that was already safe should not start failing because a newer
  // client would have sealed.
  assert.equal(presentedTailOf({ keyTail: TAIL }, () => null), TAIL);
});

test("the sealed form wins when both are present", () => {
  // A client that seals should not be downgradable by an attacker appending a
  // plain field to the handshake.
  const auth = { keyTailSealed: sealTailFor(TAIL, HOST_PUB), keyTail: "wrong-tail" };
  assert.equal(presentedTailOf(auth, () => TAIL), TAIL);
});

test("a sealed tail that will not open yields nothing", () => {
  // Not the plain field, and not undefined either — undefined would reach the
  // "no tail at all" branch, which admits a previously-approved device.
  const auth = { keyTailSealed: { epk: "x", iv: "y", ct: "z" }, keyTail: "attacker-guess" };
  assert.equal(presentedTailOf(auth, () => null), null);
});

test("a sealed field that is not an object is refused", () => {
  for (const sealed of ["string", 42, [], true]) {
    assert.equal(presentedTailOf({ keyTailSealed: sealed }, () => null), null, `accepted ${typeof sealed}`);
  }
});

test("no tail at all stays undefined", () => {
  // decideAdmission distinguishes "presented and wrong" from "not presented",
  // so an empty handshake must not become null.
  assert.equal(presentedTailOf({}, () => null), undefined);
  assert.equal(presentedTailOf(null, () => null), undefined);
});
