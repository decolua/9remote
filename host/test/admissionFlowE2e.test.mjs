// End-to-end over the admission layer: a device arrives, proves (or fails to
// prove) its key, the host answers, and the session either starts or never
// does. Both carriers are exercised through the same code, which is the point —
// every bug this replaces came from one protocol having a path the other did
// not, and each of those failures is a named test below.
//
// Run: node --test agent/test/admissionFlowE2e.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const home = mkdtempSync(join(tmpdir(), "9r-e2e-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".9remote"), { recursive: true });
const KEY = "sk-abcd1234-qrstuvwx-mnpqrstu";
const TAIL = "mnpqrstu";
writeFileSync(join(home, ".9remote", "keys.json"), JSON.stringify({ key: KEY }));

const { ConnectionRegistry } = await import("../transport/ConnectionRegistry.js");
const { planAdmission } = await import("../transport/admissionFlow.js");
const { admissionGate, submitTailProof } = await import("../lib/deviceAuth.js");
const { approveDevice, removeDevice, setAutoApprove, markDeviceRejected, clearRejectedDevice } = await import("../lib/deviceApproval.js");
const { CONNECTION_STATE } = await import("../lib/connectionConstants.js");

const NOTHING = undefined;

/** One carrier connecting: ask the gate, plan, apply. Identical for every
 *  protocol — the caller only says which id attached. */
function carrierArrives(reg, { deviceId, peerId, carrierId, presented = NOTHING }) {
  const conn = reg.open({ deviceId, peerId });
  conn.attach(carrierId, { ready: true, send: () => true });
  const verdict = admissionGate(deviceId, presented);
  if (presented !== undefined) submitTailProof(deviceId, presented);
  const plan = planAdmission(conn, verdict);
  if (plan.effects.includes("refuse")) conn.close(plan.reason);
  return { conn, plan, verdict };
}

/** The host clicking Approve: re-ask the gate for every connection of the device. */
function hostApproves(reg, deviceId) {
  approveDevice(deviceId);
  const started = [];
  for (const conn of reg.forDevice(deviceId)) {
    const plan = planAdmission(conn, admissionGate(deviceId, NOTHING));
    if (plan.effects.includes("start-session")) started.push(conn);
  }
  return started;
}

test("RTC-first, unknown device, right key: proof channel → host asked → active", () => {
  const reg = new ConnectionRegistry();
  // 1. The offer arrives with no tail — RTC carries no handshake.
  const first = carrierArrives(reg, { deviceId: "e2e-1", peerId: "e2e-1:t", carrierId: "rtc" });
  assert.deepEqual(first.plan.effects, ["open-auth-channel"],
    "must build the channel the proof travels on, not refuse");
  assert.equal(first.conn.allows("getSessions"), false, "features stay shut");

  // 2. The proof arrives over that channel.
  const proven = carrierArrives(reg, { deviceId: "e2e-1", peerId: "e2e-1:t", carrierId: "rtc", presented: TAIL });
  assert.deepEqual(proven.plan.effects, ["ask-host"], "key proven → now the host is asked");
  assert.equal(proven.conn.state, CONNECTION_STATE.awaitingHost);
  assert.equal(proven.conn.allows("getSessions"), false, "still not admitted");

  // 3. The host approves.
  const started = hostApproves(reg, "e2e-1");
  assert.equal(started.length, 1);
  assert.equal(started[0].state, CONNECTION_STATE.active);
  assert.equal(started[0].allows("getSessions"), true);
  removeDevice("e2e-1");
});

test("wrong key is refused without ever reaching the host", () => {
  // The modal asks "do you recognise this device?" — the wrong question when
  // the key itself does not check out, and a click there must not admit anyone.
  const reg = new ConnectionRegistry();
  const { conn, plan } = carrierArrives(reg,
    { deviceId: "e2e-bad", peerId: "e2e-bad:t", carrierId: "rtc", presented: "wrongkey" });
  assert.deepEqual(plan.effects, ["refuse"]);
  assert.equal(conn.closed, true);
  assert.equal(reg.forDevice("e2e-bad").length, 0, "nothing left for the host to see");
});

test("a refused device cannot walk back in on a fresh carrier", () => {
  // The RTC restart loop reconnects in milliseconds; the verdict has to outlive
  // the carrier that earned it.
  const reg = new ConnectionRegistry();
  carrierArrives(reg, { deviceId: "e2e-retry", peerId: "e2e-retry:t", carrierId: "rtc", presented: "wrongkey" });
  const retry = carrierArrives(reg, { deviceId: "e2e-retry", peerId: "e2e-retry:t2", carrierId: "rtc" });
  assert.deepEqual(retry.plan.effects, ["refuse"], "a tail-less re-offer is still refused");
  assert.equal(retry.conn.closed, true);
});

test("tunnel and RTC reach the same verdict for the same device", () => {
  // The rule the whole refactor exists for: the protocol is not part of the
  // question, so both carriers must plan identically.
  const reg = new ConnectionRegistry();
  const viaRtc = carrierArrives(reg, { deviceId: "e2e-sym-a", peerId: "a:t", carrierId: "rtc", presented: TAIL });
  const viaWs = carrierArrives(reg, { deviceId: "e2e-sym-b", peerId: "b:t", carrierId: "ws", presented: TAIL });
  assert.deepEqual(viaRtc.plan.effects, viaWs.plan.effects);
  assert.equal(viaRtc.conn.state, viaWs.conn.state);
});

test("a second carrier joins the live connection instead of starting another", () => {
  // The tunnel coming up behind RTC used to build a second PM and duplicate
  // every broadcast.
  const reg = new ConnectionRegistry();
  approveDevice("e2e-join");
  const rtc = carrierArrives(reg, { deviceId: "e2e-join", peerId: "e2e-join:t", carrierId: "rtc", presented: TAIL });
  assert.equal(rtc.conn.state, CONNECTION_STATE.active);
  const ws = carrierArrives(reg, { deviceId: "e2e-join", peerId: "e2e-join:t", carrierId: "ws" });
  assert.equal(ws.conn, rtc.conn, "same connection, one more carrier");
  assert.deepEqual(ws.conn.carrierIds, ["rtc", "ws"]);
  assert.equal(reg.forDevice("e2e-join").length, 1);
  removeDevice("e2e-join");
});

test("an approved device with a proven key skips the host entirely", () => {
  const reg = new ConnectionRegistry();
  approveDevice("e2e-known");
  const { conn, plan } = carrierArrives(reg,
    { deviceId: "e2e-known", peerId: "e2e-known:t", carrierId: "ws", presented: TAIL });
  assert.deepEqual(plan.effects, ["start-session"]);
  assert.equal(conn.active, true);
  removeDevice("e2e-known");
});

test("auto-approve still requires the key", () => {
  // Auto-approve answers the host's question, never the key's.
  setAutoApprove(true);
  const reg = new ConnectionRegistry();
  const unproven = carrierArrives(reg, { deviceId: "e2e-auto", peerId: "e2e-auto:t", carrierId: "rtc" });
  assert.deepEqual(unproven.plan.effects, ["open-auth-channel"], "no key, no entry");
  assert.equal(unproven.conn.active, false);
  const proven = carrierArrives(reg, { deviceId: "e2e-auto", peerId: "e2e-auto:t", carrierId: "rtc", presented: TAIL });
  assert.deepEqual(proven.plan.effects, ["start-session"]);
  setAutoApprove(false);
  removeDevice("e2e-auto");
});

test("every tab of a device is admitted by one approval", () => {
  const reg = new ConnectionRegistry();
  carrierArrives(reg, { deviceId: "e2e-tabs", peerId: "e2e-tabs:t1", carrierId: "rtc", presented: TAIL });
  carrierArrives(reg, { deviceId: "e2e-tabs", peerId: "e2e-tabs:t2", carrierId: "ws" });
  assert.equal(reg.forDevice("e2e-tabs").length, 2);
  const started = hostApproves(reg, "e2e-tabs");
  assert.equal(started.length, 2, "one click, both tabs");
  removeDevice("e2e-tabs");
});

test("a device refused mid-connection loses every tab at once", () => {
  const reg = new ConnectionRegistry();
  approveDevice("e2e-revoke");
  carrierArrives(reg, { deviceId: "e2e-revoke", peerId: "e2e-revoke:t1", carrierId: "rtc", presented: TAIL });
  carrierArrives(reg, { deviceId: "e2e-revoke", peerId: "e2e-revoke:t2", carrierId: "ws" });
  assert.equal(reg.closeDevice("e2e-revoke", "host-kicked"), 2);
  assert.equal(reg.forDevice("e2e-revoke").length, 0);
  removeDevice("e2e-revoke");
});

test("an unproven connection answers nothing but auth, for its whole life", () => {
  const reg = new ConnectionRegistry();
  const { conn } = carrierArrives(reg, { deviceId: "e2e-quiet", peerId: "e2e-quiet:t", carrierId: "rtc" });
  for (const event of ["getSessions", "getWorkspaces", "terminal:input", "file:read"]) {
    assert.equal(conn.allows(event), false, `${event} must not be answered`);
  }
  assert.equal(conn.allows("device:tailProof"), true, "except the proof itself");
});

test("re-entering the flow does not re-ask the host for the same device", () => {
  // The flow is re-entered on every proof and every approval, so an effect that
  // fires per entry would raise the modal again and again for one device.
  const reg = new ConnectionRegistry();
  const first = carrierArrives(reg, { deviceId: "e2e-once", peerId: "e2e-once:t", carrierId: "rtc", presented: TAIL });
  assert.deepEqual(first.plan.effects, ["ask-host"]);
  // Same session, asked again (a second carrier, a reconnect, a re-entry).
  const again = planAdmission(first.conn, admissionGate("e2e-once", NOTHING));
  assert.deepEqual(again.effects, ["ask-host"],
    "planning stays truthful; de-duplication belongs to the caller, per device");
  assert.equal(first.conn.state, CONNECTION_STATE.awaitingHost, "and the state does not drift");
  removeDevice("e2e-once");
});

test("an active connection stays active when its flow is re-entered", () => {
  // A carrier reconnecting under a live session must not restart admission.
  const reg = new ConnectionRegistry();
  approveDevice("e2e-stable");
  const { conn } = carrierArrives(reg,
    { deviceId: "e2e-stable", peerId: "e2e-stable:t", carrierId: "rtc", presented: TAIL });
  assert.equal(conn.active, true);
  const again = planAdmission(conn, admissionGate("e2e-stable", NOTHING));
  assert.deepEqual(again.effects, ["start-session"], "idempotent, not a second admission");
  assert.equal(conn.active, true);
  removeDevice("e2e-stable");
});

test("a host-rejected device is refused even mid-flow", () => {
  const reg = new ConnectionRegistry();
  const { conn } = carrierArrives(reg,
    { deviceId: "e2e-kick", peerId: "e2e-kick:t", carrierId: "rtc", presented: TAIL });
  assert.equal(conn.state, CONNECTION_STATE.awaitingHost);
  markDeviceRejected("e2e-kick", { ip: "rtc" });
  const plan = planAdmission(conn, admissionGate("e2e-kick", NOTHING));
  assert.deepEqual(plan.effects, ["refuse"]);
  clearRejectedDevice("e2e-kick");
});

test("a carrier joining a connection that is NOT active does not start it", () => {
  // The tunnel arriving behind an RTC peer that has not been admitted yet: the
  // WS may itself carry a valid tail, but the session it joins is the thing
  // that decides, and it is still waiting on the host.
  const reg = new ConnectionRegistry();
  const rtc = carrierArrives(reg, { deviceId: "e2e-late", peerId: "e2e-late:t", carrierId: "rtc", presented: TAIL });
  assert.equal(rtc.conn.state, CONNECTION_STATE.awaitingHost, "held for the host");

  // The tunnel joins the SAME session.
  const ws = carrierArrives(reg, { deviceId: "e2e-late", peerId: "e2e-late:t", carrierId: "ws", presented: TAIL });
  assert.equal(ws.conn, rtc.conn);
  assert.equal(ws.conn.active, false, "joining must not admit");
  assert.equal(ws.conn.allows("getSessions"), false, "and features stay shut on both carriers");
  removeDevice("e2e-late");
});

test("a fresh connection after a refusal does NOT clear the verdict", () => {
  // A refused connection closes, but the socket may still be up and re-enter
  // the flow — which opens a new connection object. The key verdict lives on
  // the device, not on the connection, so the new one must be refused too.
  const reg = new ConnectionRegistry();
  const first = carrierArrives(reg, { deviceId: "e2e-fresh", peerId: "e2e-fresh:t", carrierId: "rtc", presented: "wrongkey" });
  assert.equal(first.conn.closed, true);

  const second = carrierArrives(reg, { deviceId: "e2e-fresh", peerId: "e2e-fresh:t", carrierId: "rtc" });
  assert.notEqual(second.conn, first.conn, "a new connection object");
  assert.deepEqual(second.plan.effects, ["refuse"], "but the same answer");
});

test("closing a device's connections does not forget its key verdict", () => {
  // Kicking a device is about the host's decision; a key it already proved
  // stays proved, so reconnecting does not force a second proof.
  const reg = new ConnectionRegistry();
  approveDevice("e2e-keep");
  const { conn } = carrierArrives(reg, { deviceId: "e2e-keep", peerId: "e2e-keep:t", carrierId: "rtc", presented: TAIL });
  assert.equal(conn.active, true);
  reg.closeDevice("e2e-keep", "carrier-lost");

  const back = carrierArrives(reg, { deviceId: "e2e-keep", peerId: "e2e-keep:t", carrierId: "ws" });
  assert.deepEqual(back.plan.effects, ["start-session"], "straight back in, no re-proof");
  removeDevice("e2e-keep");
});
