// Tests admission gate logic: authenticate key, then authorize device.
// Run: node --test agent/test/admissionGate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// PATHS.CONFIG is read at import time, so point HOME at a scratch dir first.
const home = mkdtempSync(join(tmpdir(), "9r-gate-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".9remote"), { recursive: true });

const KEY = "sk-abcd1234-qrstuvwx-mnpqrstu";
const TAIL = "mnpqrstu";
writeFileSync(join(home, ".9remote", "keys.json"), JSON.stringify({ key: KEY }));

const { admissionGate, submitTailProof, verifyPresentedTail } = await import("../lib/deviceAuth.js");
const { setActivePairing, clearActivePairing, generatePairingTail, matchesPairingTail } = await import("../lib/pairingCode.js");
const { approveDevice, removeDevice, setAutoApprove, markDeviceRejected, clearRejectedDevice } = await import("../lib/deviceApproval.js");
const { ADMISSION, TAIL_REJECT_REASON } = await import("../lib/transportConstants.js");

const NOTHING = undefined;

test("unknown device, nothing presented → waits for the proof, never the host", () => {
  const r = admissionGate("dev-wait", NOTHING);
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.hold);
  assert.equal(r.reason, "awaiting-proof");
});

test("wrong tail → rejected on the KEY, so no modal can override it", () => {
  const r = admissionGate("dev-wrong", "badtail1");
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.reject);
  assert.equal(r.reason, TAIL_REJECT_REASON.mismatch);
});

test("a seal that will not open is rejected, and says so", () => {
  const r = admissionGate("dev-seal", null);
  assert.equal(r.decision, ADMISSION.reject);
  assert.equal(r.reason, TAIL_REJECT_REASON.sealUnreadable);
});

test("right tail from an UNKNOWN device → host still decides", () => {
  const r = admissionGate("dev-new", TAIL);
  assert.equal(r.step, "authz");
  assert.equal(r.decision, ADMISSION.hold);
});

test("right tail from an APPROVED device → admitted", () => {
  approveDevice("dev-known");
  const r = admissionGate("dev-known", TAIL);
  assert.equal(r.step, "authz");
  assert.equal(r.decision, ADMISSION.admit);
  removeDevice("dev-known");
});

test("approved device that has NOT proven yet is not admitted on standing alone", () => {
  approveDevice("dev-standing");
  const r = admissionGate("dev-standing", NOTHING);
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.hold);
  removeDevice("dev-standing");
});

test("a verdict is remembered per device, so another carrier cannot re-ask", () => {
  submitTailProof("dev-settled", "wrongtail");
  const again = admissionGate("dev-settled", NOTHING);
  assert.equal(again.decision, ADMISSION.reject);
  assert.equal(again.reason, TAIL_REJECT_REASON.mismatch);
});

test("a proof accepted on one carrier admits the device on the next", () => {
  approveDevice("dev-cross");
  submitTailProof("dev-cross", TAIL);
  const r = admissionGate("dev-cross", NOTHING);
  assert.equal(r.step, "authz");
  assert.equal(r.decision, ADMISSION.admit);
  removeDevice("dev-cross");
});

test("auto-approve admits a PROVEN device, and only a proven one", () => {
  setAutoApprove(true);
  assert.equal(admissionGate("dev-auto-a", TAIL).decision, ADMISSION.admit);
  const unproven = admissionGate("dev-auto-b", NOTHING);
  assert.equal(unproven.step, "auth");
  assert.equal(unproven.decision, ADMISSION.hold);
  assert.equal(admissionGate("dev-auto-c", "badtail1").decision, ADMISSION.reject);
  setAutoApprove(false);
});

test("enrollment over the fp2-checked channel counts as proof", () => {
  approveDevice("dev-enrolled");
  const r = admissionGate("dev-enrolled", NOTHING, { provenSocket: true });
  assert.equal(r.decision, ADMISSION.admit);
  removeDevice("dev-enrolled");
});

test("one device's wrong key does not touch another device's verdict", () => {
  approveDevice("dev-good");
  submitTailProof("dev-good", TAIL);
  submitTailProof("dev-bad", "wrongtail");
  assert.equal(admissionGate("dev-good", NOTHING).decision, ADMISSION.admit);
  assert.equal(admissionGate("dev-bad", NOTHING).decision, ADMISSION.reject);
  removeDevice("dev-good");
});

test("two tabs of one device share a single verdict", () => {
  approveDevice("dev-tabs");
  submitTailProof("dev-tabs", TAIL);
  const tabA = admissionGate("dev-tabs", NOTHING);
  const tabB = admissionGate("dev-tabs", NOTHING);
  assert.equal(tabA.decision, ADMISSION.admit);
  assert.equal(tabB.decision, ADMISSION.admit);
  removeDevice("dev-tabs");
});

test("a refusal survives the retry loop but not a deliberate correction", () => {
  submitTailProof("dev-locked", "wrongtail");
  assert.equal(admissionGate("dev-locked", NOTHING).decision, ADMISSION.reject,
    "the loop gets nothing");
  approveDevice("dev-locked");
  assert.equal(admissionGate("dev-locked", TAIL).decision, ADMISSION.admit,
    "the person who corrects the typo gets in");
  removeDevice("dev-locked");
});

test("a host-rejected device is refused before its key is even considered", () => {
  markDeviceRejected("dev-kicked", { ip: "rtc" });
  const r = admissionGate("dev-kicked", NOTHING);
  assert.equal(r.decision, ADMISSION.reject);
  clearRejectedDevice("dev-kicked");
});

test("a device with no id is never admitted", () => {
  assert.notEqual(admissionGate(null, TAIL).decision, ADMISSION.admit);
});

test("the carrier cannot change the answer", () => {
  const overRtc = admissionGate("dev-carrier", NOTHING);
  const overWs = admissionGate("dev-carrier", NOTHING);
  assert.deepEqual(overRtc, overWs);
  assert.equal(overRtc.step, "auth");
  assert.equal(overRtc.decision, ADMISSION.hold);
});

test("a live one-time code carries a QR pairing through gate 1, not gate 2", async () => {
  const { getActivePairing } = await import("../lib/pairingCode.js");
  const live = getActivePairing()?.tempKey;
  if (!live) return;
  const r = admissionGate("dev-qr", NOTHING, { tempKey: live });
  assert.equal(r.step, "authz");
});

test("a one-time code's TAIL is two characters", () => {
  assert.equal(generatePairingTail().length, 2);
});

test("right one-time TAIL passes gate 1, then the host still decides", () => {
  const tail = generatePairingTail();
  setActivePairing("K7QP3M", tail, Date.now() + 60000);
  const r = admissionGate("dev-pair-ok", tail, { tempKey: "K7QP3M" });
  assert.equal(r.step, "authz");
  assert.equal(r.decision, ADMISSION.hold);
  clearActivePairing();
});

test("wrong one-time TAIL is refused exactly like a wrong API key", () => {
  setActivePairing("K7QP3M", "ab", Date.now() + 60000);
  const r = admissionGate("dev-pair-bad", "zz", { tempKey: "K7QP3M" });
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.reject);
  assert.equal(r.reason, TAIL_REJECT_REASON.mismatch);
  clearActivePairing();
});

test("a pairing device that presents nothing waits for its proof", () => {
  setActivePairing("K7QP3M", "ab", Date.now() + 60000);
  const r = admissionGate("dev-pair-wait", NOTHING, { tempKey: "K7QP3M" });
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.hold);
  clearActivePairing();
});

test("an expired code admits nobody, right TAIL or not", () => {
  setActivePairing("K7QP3M", "ab", Date.now() - 1);
  const r = admissionGate("dev-pair-expired", "ab", { tempKey: "K7QP3M" });
  assert.notEqual(r.decision, ADMISSION.admit);
  clearActivePairing();
});

test("a pairing device proves against the CODE's tail, not the key's", async () => {
  const { setActivePairing, clearActivePairing } = await import("../lib/pairingCode.js");
  setActivePairing("ABC123", "codetail", Date.now() + 60_000);
  const ok = admissionGate("dev-pairing", "codetail", { tempKey: "ABC123" });
  assert.equal(ok.step, "authz", "the code's tail carried it past gate 1");
  assert.notEqual(ok.decision, ADMISSION.reject);
  clearActivePairing();
});

test("a pairing device presenting the wrong tail is refused", async () => {
  const { setActivePairing, clearActivePairing } = await import("../lib/pairingCode.js");
  setActivePairing("XYZ789", "codetail", Date.now() + 60_000);
  const bad = admissionGate("dev-pairing-bad", "guessed1", { tempKey: "XYZ789" });
  assert.equal(bad.step, "auth");
  assert.equal(bad.decision, ADMISSION.reject);
  clearActivePairing();
});

test("a pairing device's proof is checked against the CODE, on any carrier", async () => {
  const { setActivePairing, clearActivePairing } = await import("../lib/pairingCode.js");
  const { handleTailProof } = await import("../lib/deviceAuth.js");
  setActivePairing("PQR456", "codetail", Date.now() + 60_000);
  const socket = {
    handshake: { auth: { deviceId: "dev-proof-pairing", tempKey: "PQR456" } },
    data: {}
  };
  assert.equal(handleTailProof(socket, { keyTail: "codetail" }), true,
    "the code's tail must be accepted over the channel too");
  clearActivePairing();
});

test("an RTC-first pairing proof carries its own code, having no handshake", async () => {
  const { setActivePairing, clearActivePairing } = await import("../lib/pairingCode.js");
  const { handleTailProof } = await import("../lib/deviceAuth.js");
  setActivePairing("RTC999", "codetail", Date.now() + 60_000);
  const virtualSocket = {
    handshake: { auth: { deviceId: "dev-rtc-pairing" } },
    data: {}
  };
  assert.equal(handleTailProof(virtualSocket, { keyTail: "codetail", tempKey: "RTC999" }), true);
  clearActivePairing();
});

test("a wrong tail refuses THIS attempt, not the device forever", () => {
  approveDevice("dev-typo");
  assert.equal(admissionGate("dev-typo", "badtail1").decision, ADMISSION.reject);
  submitTailProof("dev-typo", "badtail1");
  assert.equal(admissionGate("dev-typo", TAIL).decision, ADMISSION.admit,
    "the right key must still work after a mistake");
  removeDevice("dev-typo");
});

test("a refusal still stops a carrier that presents nothing", () => {
  submitTailProof("dev-loop", "wrongtail");
  assert.equal(admissionGate("dev-loop", NOTHING).decision, ADMISSION.reject,
    "a tail-less re-offer inherits the refusal");
});

test("asking the gate about a pairing code does not spend the code", () => {
  const tail = generatePairingTail();
  setActivePairing("ABC123", tail, Date.now() + 60000);
  admissionGate("dev-look", "wrongwrong", { tempKey: "wrongwrong" });
  admissionGate("dev-look", "wrongwrong", { tempKey: "wrongwrong" });
  const r = admissionGate("dev-look2", tail, { tempKey: tail });
  assert.equal(r.step, "authz", "the right code still works");
  clearActivePairing();
});

test("submitting a wrong pairing tail kills the code on the first try", () => {
  const tail = generatePairingTail();
  setActivePairing("ABC124", tail, Date.now() + 60000);
  assert.equal(submitTailProof("dev-burn", "wrongwrong", { pairing: true }), false);
  assert.equal(submitTailProof("dev-burn2", tail, { pairing: true }), false,
    "a killed code cannot be redeemed, not even correctly");
  clearActivePairing();
});

test("presenting nothing does not kill a live code", () => {
  const tail = generatePairingTail();
  setActivePairing("ABC125", tail, Date.now() + 60000);
  submitTailProof("dev-empty", "", { pairing: true });
  submitTailProof("dev-empty", null, { pairing: true });
  assert.equal(matchesPairingTail(tail), true, "the code is still alive");
  clearActivePairing();
});

test("pre-login verification answers the same question as the gate", () => {
  assert.equal(verifyPresentedTail({ tail: TAIL }).ok, true);
  assert.equal(verifyPresentedTail({ tail: "badtail1" }).ok, false);
  assert.equal(verifyPresentedTail({ tail: "" }).ok, false);
});

test("pre-login verification settles nothing", () => {
  verifyPresentedTail({ tail: "badtail1" });
  approveDevice("dev-preflight");
  assert.equal(admissionGate("dev-preflight", TAIL).decision, ADMISSION.admit,
    "a failed pre-check leaves no verdict behind");
  removeDevice("dev-preflight");
});

test("pre-login verification burns a one-time code on a wrong TAIL", () => {
  const tail = generatePairingTail();
  setActivePairing("ABC126", tail, Date.now() + 60000);
  assert.equal(verifyPresentedTail({ tail, tempKey: "ABC126" }).ok, true);
  assert.equal(matchesPairingTail(tail), true, "a correct check leaves the code alive");
  assert.equal(verifyPresentedTail({ tail: "ZZ", tempKey: "ABC126" }).ok, false);
  assert.equal(matchesPairingTail(tail), false, "a wrong check burns the code");
  clearActivePairing();
});
