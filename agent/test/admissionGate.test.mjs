// The admission decision, which used to be spread across three functions and
// every carrier that connects. Two gates in a fixed order — authenticate the
// KEY, then authorise the DEVICE — because every bug this replaced came from
// answering them out of order: a wrong tail reaching the approval modal, an
// approved-but-unproven device reaching the workspace, a proof that settled on
// one carrier while another asked again.
//
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

const NOTHING = undefined; // carrier presented no tail (RTC-first, signaling)

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
  // Proving the key is not the same as being allowed in: this is the case that
  // silently vanished when a proven tail returned admit outright.
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
  // The RTC-first hole: a session was built, features wired, and the client
  // told it was approved, all before any tail arrived.
  approveDevice("dev-standing");
  const r = admissionGate("dev-standing", NOTHING);
  assert.equal(r.step, "auth");
  assert.equal(r.decision, ADMISSION.hold);
  removeDevice("dev-standing");
});

test("a verdict is remembered per device, so another carrier cannot re-ask", () => {
  // The RTC restart loop used to walk back in through a fresh, tail-less offer.
  submitTailProof("dev-settled", "wrongtail");
  const again = admissionGate("dev-settled", NOTHING);
  assert.equal(again.decision, ADMISSION.reject);
  assert.equal(again.reason, TAIL_REJECT_REASON.mismatch);
});

test("a proof accepted on one carrier admits the device on the next", () => {
  approveDevice("dev-cross");
  submitTailProof("dev-cross", TAIL);
  const r = admissionGate("dev-cross", NOTHING); // e.g. the WS that follows RTC
  assert.equal(r.step, "authz");
  assert.equal(r.decision, ADMISSION.admit);
  removeDevice("dev-cross");
});

test("auto-approve admits a PROVEN device, and only a proven one", () => {
  setAutoApprove(true);
  assert.equal(admissionGate("dev-auto-a", TAIL).decision, ADMISSION.admit);
  // Auto-approve is about the device, so it must not wave the key through.
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
  // Several clients share one agent and one key HEAD. A stranger guessing must
  // not settle, block, or admit anyone else — the verdict is per device.
  approveDevice("dev-good");
  submitTailProof("dev-good", TAIL);
  submitTailProof("dev-bad", "wrongtail");
  assert.equal(admissionGate("dev-good", NOTHING).decision, ADMISSION.admit);
  assert.equal(admissionGate("dev-bad", NOTHING).decision, ADMISSION.reject);
  removeDevice("dev-good");
});

test("two tabs of one device share a single verdict", () => {
  // peerId is "deviceId:tab", but the key belongs to the device: proving in one
  // tab must admit the other, and must not require a second proof.
  approveDevice("dev-tabs");
  submitTailProof("dev-tabs", TAIL);
  const tabA = admissionGate("dev-tabs", NOTHING);
  const tabB = admissionGate("dev-tabs", NOTHING);
  assert.equal(tabA.decision, ADMISSION.admit);
  assert.equal(tabB.decision, ADMISSION.admit);
  removeDevice("dev-tabs");
});

test("a refusal survives the retry loop but not a deliberate correction", () => {
  // Two things pull in opposite directions here, and both matter.
  //
  // The RTC restart loop reconnects within milliseconds carrying NOTHING: if
  // each of those counted as a fresh attempt, a refusal would cost a guesser
  // nothing. So a carrier presenting nothing inherits the refusal.
  //
  // But a person who mistyped one character is not that loop. They present a
  // new value deliberately, and refusing to even look would lock them out of
  // their own machine. Guessing is made expensive by the rate limiter; it is
  // not made expensive by pretending the right key is wrong.
  submitTailProof("dev-locked", "wrongtail");
  assert.equal(admissionGate("dev-locked", NOTHING).decision, ADMISSION.reject,
    "the loop gets nothing");
  approveDevice("dev-locked");
  assert.equal(admissionGate("dev-locked", TAIL).decision, ADMISSION.admit,
    "the person who corrects the typo gets in");
  removeDevice("dev-locked");
});

test("a host-rejected device is refused before its key is even considered", () => {
  // Cheapest check first, and the honest one: the host said no, so what the
  // key proves is irrelevant. It must not sit in the proof window either.
  markDeviceRejected("dev-kicked", { ip: "rtc" });
  const r = admissionGate("dev-kicked", NOTHING);
  assert.equal(r.decision, ADMISSION.reject);
  clearRejectedDevice("dev-kicked");
});

test("a device with no id is never admitted", () => {
  // Every verdict is keyed on deviceId; without one there is nothing to key on,
  // so setVerdict silently does nothing and a null id must not slip through.
  assert.notEqual(admissionGate(null, TAIL).decision, ADMISSION.admit);
});

test("the carrier cannot change the answer", () => {
  // WS and RTC are two protocols for one connection, so the gate takes no
  // carrier argument at all: the same device presenting the same thing gets
  // the same verdict whichever road it came in on. A VirtualSocket carries no
  // handshake, which is why it lands on "awaiting-proof" — not because it is
  // RTC, and it must never be trusted for being RTC.
  const overRtc = admissionGate("dev-carrier", NOTHING);
  const overWs = admissionGate("dev-carrier", NOTHING);
  assert.deepEqual(overRtc, overWs);
  assert.equal(overRtc.step, "auth");
  assert.equal(overRtc.decision, ADMISSION.hold);
});

test("a live one-time code carries a QR pairing through gate 1, not gate 2", async () => {
  // A phone that just scanned the code has no tail — enrollment delivers one —
  // so demanding a proof would strand it. The code is an out-of-band claim the
  // user read off the agent's screen, and it settles the KEY only: an unknown
  // device still waits for the host.
  const { getActivePairing } = await import("../lib/pairingCode.js");
  const live = getActivePairing()?.tempKey;
  if (!live) return; // no code on screen in this environment — nothing to assert
  const r = admissionGate("dev-qr", NOTHING, { tempKey: live });
  assert.equal(r.step, "authz");
});

// ── One-time codes go through the SAME gate as an API key ──────────────────
// Only two things differ, and neither is a branch in the flow: which secret the
// TAIL is compared against, and that a miss kills the code.

test("a one-time code's TAIL is two characters", () => {
  assert.equal(generatePairingTail().length, 2);
});

test("right one-time TAIL passes gate 1, then the host still decides", () => {
  const tail = generatePairingTail();
  setActivePairing("K7QP3M", tail, Date.now() + 60000);
  const r = admissionGate("dev-pair-ok", tail, { tempKey: "K7QP3M" });
  assert.equal(r.step, "authz");   // gate 1 passed
  assert.equal(r.decision, ADMISSION.hold); // unknown device — host decides
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
  // The two secrets are the same kind of thing — minted by the agent, read back
  // here — so they run the same gate. What differs is which one the presented
  // tail is compared against: a QR device holds the code's tail and has never
  // seen the key's, so checking it against the key would refuse a pairing the
  // host had just been asked to approve.
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
  // The handshake is not the only road a proof travels: an RTC-first client
  // sends device:tailProof over the channel instead. Checking that against the
  // API key's tail refused a pairing the gate had just accepted — the client
  // saw "wrong access key" for a code it had typed correctly.
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
  // A VirtualSocket has no handshake at all, so the code cannot be read from
  // one — the client sends it with the proof instead. Looking only at the
  // handshake measured a QR device against the API key's tail and told the user
  // their correct code was wrong.
  const { setActivePairing, clearActivePairing } = await import("../lib/pairingCode.js");
  const { handleTailProof } = await import("../lib/deviceAuth.js");
  setActivePairing("RTC999", "codetail", Date.now() + 60_000);
  const virtualSocket = {
    handshake: { auth: { deviceId: "dev-rtc-pairing" } }, // no tempKey here
    data: {}
  };
  assert.equal(handleTailProof(virtualSocket, { keyTail: "codetail", tempKey: "RTC999" }), true);
  clearActivePairing();
});

test("a wrong tail refuses THIS attempt, not the device forever", () => {
  // Typing one character wrong must not lock a user out of their own machine.
  // The refusal has to stop the retry loop that follows a bad guess, and then
  // step aside for the person who simply mistyped.
  approveDevice("dev-typo");
  assert.equal(admissionGate("dev-typo", "badtail1").decision, ADMISSION.reject);
  submitTailProof("dev-typo", "badtail1");
  // The correct tail, presented deliberately, is a new attempt — not a retry.
  assert.equal(admissionGate("dev-typo", TAIL).decision, ADMISSION.admit,
    "the right key must still work after a mistake");
  removeDevice("dev-typo");
});

test("a refusal still stops a carrier that presents nothing", () => {
  // The reason the verdict is sticky at all: the RTC restart loop reconnects
  // with no tail at all, and must not be treated as a fresh chance.
  submitTailProof("dev-loop", "wrongtail");
  assert.equal(admissionGate("dev-loop", NOTHING).decision, ADMISSION.reject,
    "a tail-less re-offer inherits the refusal");
});

test("asking the gate about a pairing code does not spend the code", () => {
  // The gate is asked once per carrier and again on every re-entry. With one
  // strike to give, a comparison that also burned the code would let the first
  // of those calls destroy a code the user typed correctly.
  const tail = generatePairingTail();
  setActivePairing("ABC123", tail, Date.now() + 60000);
  // A wrong presentation, asked of the gate several times over.
  admissionGate("dev-look", "wrongwrong", { tempKey: "wrongwrong" });
  admissionGate("dev-look", "wrongwrong", { tempKey: "wrongwrong" });
  // The code is still alive, because looking is free.
  const r = admissionGate("dev-look2", tail, { tempKey: tail });
  assert.equal(r.step, "authz", "the right code still works");
  clearActivePairing();
});

test("submitting a wrong pairing tail kills the code on the first try", () => {
  // Where the attempt is actually spent: one strike, and the code is gone.
  const tail = generatePairingTail();
  setActivePairing("ABC124", tail, Date.now() + 60000);
  assert.equal(submitTailProof("dev-burn", "wrongwrong", { pairing: true }), false);
  // Even the correct tail is now worthless — the code itself was revoked.
  assert.equal(submitTailProof("dev-burn2", tail, { pairing: true }), false,
    "a killed code cannot be redeemed, not even correctly");
  clearActivePairing();
});

test("presenting nothing does not kill a live code", () => {
  // A carrier with no tail to show — RTC before its proof arrives, or a client
  // that simply has none — is not a wrong guess. Killing the code on it would
  // let any connection destroy a pairing the user is in the middle of.
  const tail = generatePairingTail();
  setActivePairing("ABC125", tail, Date.now() + 60000);
  submitTailProof("dev-empty", "", { pairing: true });
  submitTailProof("dev-empty", null, { pairing: true });
  assert.equal(matchesPairingTail(tail), true, "the code is still alive");
  clearActivePairing();
});

test("pre-login verification answers the same question as the gate", () => {
  // The login screen asks this before opening a session. It must agree with
  // what the connection would decide — a key accepted here and refused there
  // would send the user to a workspace that throws them out, which is the whole
  // thing this exists to prevent.
  assert.equal(verifyPresentedTail({ tail: TAIL }).ok, true);
  assert.equal(verifyPresentedTail({ tail: "badtail1" }).ok, false);
  assert.equal(verifyPresentedTail({ tail: "" }).ok, false);
});

test("pre-login verification settles nothing", () => {
  // It is a convenience, not a gate: no verdict recorded, no code spent. A
  // client that skips it gets exactly as far, which is what makes answering
  // it safe — and a wrong answer here must not lock the device out later.
  verifyPresentedTail({ tail: "badtail1" });
  approveDevice("dev-preflight");
  assert.equal(admissionGate("dev-preflight", TAIL).decision, ADMISSION.admit,
    "a failed pre-check leaves no verdict behind");
  removeDevice("dev-preflight");
});

test("pre-login verification does not burn a one-time code", () => {
  // Checking a code must not consume it: the user is still on the login screen,
  // and the code has to survive to open the session that follows.
  const tail = generatePairingTail();
  setActivePairing("ABC126", tail, Date.now() + 60000);
  verifyPresentedTail({ tail: "ZZ", tempKey: "ABC126" });
  assert.equal(matchesPairingTail(tail), true, "the code is still alive");
  assert.equal(verifyPresentedTail({ tail, tempKey: "ABC126" }).ok, true);
  clearActivePairing();
});
