// The connection layer: one device's presence on this host, the book that
// holds every such presence, and the callbacks waiting on a key proof.
//
// These three used to be separate files because they were written separately;
// they are one layer and one set of rules, so they read better together. What
// they lock down is what kept breaking while the lifecycle lived inside a
// HostBus: approval cannot precede the key proof, an inactive connection
// carries nothing but auth, no carrier gets a say, and a verdict about a device
// reaches every tab it holds.
//
// Run: node --test agent/test/connection.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// PATHS.CONFIG is read at import time, so point HOME at a scratch dir first.
const home = mkdtempSync(join(tmpdir(), "9r-conn-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".9remote"), { recursive: true });
const KEY = "sk-abcd1234-qrstuvwx-mnpqrstu";
const TAIL = "mnpqrstu";
writeFileSync(join(home, ".9remote", "keys.json"), JSON.stringify({ key: KEY }));

const { Connection } = await import("../transport/Connection.js");
const { ConnectionRegistry } = await import("../transport/ConnectionRegistry.js");
const { CONNECTION_STATE } = await import("../lib/connectionConstants.js");
const { onTailProven, submitTailProof, clearProofWaiters } = await import("../lib/deviceAuth.js");

const newConnection = () => new Connection({ deviceId: "dev-1", peerId: "dev-1:tab" });
const fakeCarrier = (ready = true) => ({ ready, send: () => true, disconnect: () => {} });

// ── Lifecycle ────────────────────────────────────────────────────────────────

test("a fresh connection is authenticating and carries only auth", () => {
  const s = newConnection();
  assert.equal(s.state, CONNECTION_STATE.authenticating);
  assert.equal(s.allows("device:tailProof"), true);
  assert.equal(s.allows("device:clientReady"), true);
  assert.equal(s.allows("getSessions"), false, "features must not answer yet");
  assert.equal(s.allows("terminal:input"), false);
});

test("proving the key does NOT admit — the host still decides", () => {
  // The rule that vanished when a proven tail returned admit outright.
  const s = newConnection();
  assert.equal(s.keyProven(), true);
  assert.equal(s.state, CONNECTION_STATE.awaitingHost);
  assert.equal(s.active, false);
  assert.equal(s.allows("getSessions"), false, "still not a session");
});

test("approval cannot skip the key proof", () => {
  // A click must never stand in for the proof: hostAllowed refuses to jump.
  const s = newConnection();
  assert.equal(s.hostAllowed(), false);
  assert.equal(s.state, CONNECTION_STATE.authenticating);
  assert.equal(s.active, false);
});

test("both gates, in order, make it active", () => {
  const s = newConnection();
  s.keyProven();
  assert.equal(s.hostAllowed(), true);
  assert.equal(s.state, CONNECTION_STATE.active);
  assert.equal(s.allows("getSessions"), true);
  assert.equal(s.allows("anything"), true);
});

test("a closed connection carries nothing, not even auth", () => {
  const s = newConnection();
  s.close("wrong-key");
  assert.equal(s.state, CONNECTION_STATE.closed);
  assert.equal(s.allows("device:tailProof"), false);
  assert.equal(s.allows("getSessions"), false);
});

test("state changes are announced once, with where they came from", () => {
  const seen = [];
  const s = newConnection();
  s.on("state", (e) => seen.push(`${e.from}→${e.to}:${e.reason}`));
  s.keyProven();
  s.hostAllowed();
  s.close("done");
  assert.deepEqual(seen, [
    "authenticating→awaitingHost:key-proven",
    "awaitingHost→active:host-allowed",
    "active→closed:done"
  ]);
});

test("a repeated transition is refused rather than re-announced", () => {
  const s = newConnection();
  let events = 0;
  s.on("state", () => { events++; });
  assert.equal(s.keyProven(), true);
  assert.equal(s.keyProven(), false, "already past authenticating");
  assert.equal(events, 1);
});

test("carriers attach and detach without touching the lifecycle", () => {
  // The whole point: which protocol is present says nothing about admission.
  const s = newConnection();
  s.attach("rtc", fakeCarrier());
  assert.deepEqual(s.carrierIds, ["rtc"]);
  assert.equal(s.state, CONNECTION_STATE.authenticating, "attaching admits nobody");
  s.attach("ws", fakeCarrier());
  assert.deepEqual(s.carrierIds, ["rtc", "ws"]);
  s.detach("rtc");
  assert.deepEqual(s.carrierIds, ["ws"]);
  assert.equal(s.state, CONNECTION_STATE.authenticating, "losing a carrier admits nobody either");
});

test("re-attaching an id replaces the carrier instead of stacking one", () => {
  // A reconnecting tunnel must not leave its predecessor behind.
  const s = newConnection();
  const first = fakeCarrier();
  const second = fakeCarrier();
  s.attach("ws", first);
  s.attach("ws", second);
  assert.deepEqual(s.carrierIds, ["ws"]);
  assert.equal(s.carrier("ws"), second);
});

test("connected reflects the carriers, not the verdict", () => {
  const s = newConnection();
  assert.equal(s.connected, false);
  s.attach("rtc", fakeCarrier(false));
  assert.equal(s.connected, false, "attached but not ready");
  s.attach("ws", fakeCarrier(true));
  assert.equal(s.connected, true);
});

test("closing detaches every carrier", () => {
  const s = newConnection();
  s.attach("rtc", fakeCarrier());
  s.attach("ws", fakeCarrier());
  const detached = [];
  s.on("carrierDetached", (id) => detached.push(id));
  s.close("host-rejected");
  assert.deepEqual(detached.sort(), ["rtc", "ws"]);
  assert.deepEqual(s.carrierIds, []);
});

test("a closed connection refuses to reopen", () => {
  const s = newConnection();
  s.close("gone");
  assert.equal(s.keyProven(), false);
  assert.equal(s.hostAllowed(), false);
  assert.equal(s.attach("ws", fakeCarrier()), false);
  assert.equal(s.state, CONNECTION_STATE.closed);
});

test("an active connection survives a carrier dying and coming back", () => {
  // The tunnel flapping, or RTC restarting, must not cost a device its
  // admission: carriers are attachments, and losing one is not a verdict.
  const s = newConnection();
  s.attach("rtc", fakeCarrier());
  s.keyProven();
  s.hostAllowed();
  assert.equal(s.active, true);
  s.detach("rtc");
  assert.equal(s.active, true, "still admitted with no carrier at all");
  assert.equal(s.connected, false);
  s.attach("rtc", fakeCarrier());
  assert.equal(s.active, true);
  assert.equal(s.allows("getSessions"), true, "and it never had to re-prove");
});

test("a connection admitted on one carrier admits the other one too", () => {
  // Admission belongs to the device. A second protocol joining must not find
  // itself facing the gate again.
  const s = newConnection();
  s.attach("rtc", fakeCarrier());
  s.keyProven();
  s.hostAllowed();
  s.attach("ws", fakeCarrier());
  assert.equal(s.state, CONNECTION_STATE.active);
  assert.equal(s.allows("terminal:input"), true);
});

// ── The registry ─────────────────────────────────────────────────────────────

test("opening twice for one peer returns the same session", () => {
  // The tunnel and RTC both arriving for one tab must not make two sessions —
  // that is the double-PM bug in its original form.
  const reg = new ConnectionRegistry();
  const a = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  const b = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  assert.equal(a, b);
  assert.equal(reg.size, 1);
});

test("one device, several tabs, several sessions", () => {
  const reg = new ConnectionRegistry();
  reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  reg.open({ deviceId: "d1", peerId: "d1:tab2" });
  assert.equal(reg.forDevice("d1").length, 2);
  assert.equal(reg.size, 2);
});

test("a verdict about the device reaches every tab it holds", () => {
  // Refusing a key must not leave one tab alive on another carrier.
  const reg = new ConnectionRegistry();
  reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  reg.open({ deviceId: "d1", peerId: "d1:tab2" });
  reg.open({ deviceId: "d2", peerId: "d2:tab1" });
  assert.equal(reg.closeDevice("d1", "wrong-key"), 2);
  assert.equal(reg.forDevice("d1").length, 0);
  assert.equal(reg.forDevice("d2").length, 1, "an unrelated device is untouched");
});

test("a closed session leaves the book on its own", () => {
  // Nobody should have to remember to unregister — forgetting is how stale
  // sessions used to keep answering.
  const reg = new ConnectionRegistry();
  const s = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  s.close("done");
  assert.equal(reg.get("d1:tab1"), null);
  assert.equal(reg.size, 0);
  assert.equal(reg.forDevice("d1").length, 0);
});

test("reopening after a close gives a fresh session, not the dead one", () => {
  const reg = new ConnectionRegistry();
  const first = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  first.close("network");
  const second = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  assert.notEqual(first, second);
  assert.equal(second.closed, false);
});

test("get never hands back a closed session", () => {
  const reg = new ConnectionRegistry();
  const s = reg.open({ deviceId: "d1", peerId: "d1:tab1" });
  assert.equal(reg.get("d1:tab1"), s);
  s.close("gone");
  assert.equal(reg.get("d1:tab1"), null);
});

test("a peerless carrier still gets a session keyed on the device", () => {
  const reg = new ConnectionRegistry();
  const s = reg.open({ deviceId: "d1" });
  assert.equal(s.peerId, "d1");
  assert.equal(reg.get("d1"), s);
});

// ── Waiting on a proof ───────────────────────────────────────────────────────

test("every tab waiting on one device is woken by a single proof", () => {
  const woken = [];
  for (const tab of ["t1", "t2", "t3"]) onTailProven("dev-multi", () => woken.push(tab));
  submitTailProof("dev-multi", TAIL);
  assert.deepEqual(woken, ["t1", "t2", "t3"]);
});

test("a refused proof wakes nobody — no tab may show the approval modal", () => {
  let woken = 0;
  onTailProven("dev-refused", () => { woken++; });
  onTailProven("dev-refused", () => { woken++; });
  submitTailProof("dev-refused", "wrongtail");
  assert.equal(woken, 0);
});

test("one tab's expiry does not cancel another tab's waiter", async () => {
  // Both tabs wait; the first is armed with a deadline, the second is not.
  // Firing the first must leave the second able to be woken by the proof.
  let expired = 0;
  let woken = 0;
  onTailProven("dev-expiry", () => { woken++; }, () => { expired++; });
  onTailProven("dev-expiry", () => { woken++; });
  submitTailProof("dev-expiry", TAIL);
  assert.equal(woken, 2, "both tabs woken by the proof");
  assert.equal(expired, 0, "no deadline fires once the proof landed");
});

test("waiters registered while a proof is being processed are not lost", () => {
  // A tab that re-arms from inside its own callback (a reconnect landing in the
  // same tick) must not be dropped by the flush that is running.
  let second = false;
  onTailProven("dev-rearm", () => {
    onTailProven("dev-rearm", () => { second = true; });
  });
  submitTailProof("dev-rearm", TAIL);
  // Already proven, so the re-armed waiter runs immediately rather than queueing.
  assert.equal(second, true);
});

test("clearing one device leaves other devices' waiters intact", () => {
  let a = false, b = false;
  onTailProven("dev-a", () => { a = true; });
  onTailProven("dev-b", () => { b = true; });
  clearProofWaiters("dev-a");
  submitTailProof("dev-a", TAIL);
  submitTailProof("dev-b", TAIL);
  assert.equal(a, false, "cleared device's waiter must not fire");
  assert.equal(b, true, "an unrelated device is unaffected");
});

test("losing one carrier while another is up does not end the connection", () => {
  // The tunnel dropping while RTC carries the session is a switch, not a
  // departure: closing on it would tear down a client that is still there.
  const s = newConnection();
  s.attach("rtc", fakeCarrier(true));
  s.attach("ws", fakeCarrier(true));
  s.keyProven();
  s.hostAllowed();
  s.detach("ws");
  assert.equal(s.connected, true, "RTC still carries it");
  assert.equal(s.closed, false);
});

test("losing the LAST carrier leaves nothing connected", () => {
  // What "online" has to mean: a closed browser must not keep reporting itself
  // as present. The caller closes on this — the connection only states it.
  const s = newConnection();
  s.attach("rtc", fakeCarrier(true));
  s.keyProven();
  s.hostAllowed();
  s.detach("rtc");
  assert.equal(s.connected, false, "nothing left to carry it");
  s.close("carrier-gone");
  assert.equal(s.closed, true);
});

test("a carrier that is attached but not ready does not count as connected", () => {
  // Attaching happens before the adapter opens; only a carrier that can move
  // bytes makes a connection live.
  const s = newConnection();
  s.attach("ws", fakeCarrier(false));
  assert.equal(s.connected, false);
});
