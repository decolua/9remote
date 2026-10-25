import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../app.js";
import { PROTOCOL, encodeFrame, decodeFrame, LIMITS, send } from "../../shared/relay/protocol.js";
const password = "test-admin-long-password";
const registrationPassword = "test-registration-password";
async function fixture(t, config = {}) {
  const app = await createApp({ adminPassword: password, registrationPassword, ...config });
  app.http.listen(0, "127.0.0.1"); await once(app.http, "listening");
  const url = `http://127.0.0.1:${app.http.address().port}`;
  t.after(() => app.close());
  async function api(path, token, data, method) {
    const r = await fetch(url + path, { method: method || (data ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: r.status, ...await r.json() };
  }
  const admin = await api("/api/admin/login", null, { password });
  async function register(role) { return api("/api/devices/register", null, { role, name: role, password: registrationPassword }); }
  return { app, url, api, admin: admin.token, register };
}
async function connectHost(f, device) {
  const ws = new WebSocket(f.url.replace("http", "ws") + "/relay/host", PROTOCOL, { headers: { Authorization: `Bearer ${device.token}` } });
  await once(ws, "open"); return ws;
}
async function connectClient(f, client, host) {
  const ticket = await f.api("/api/tickets", client.token, { hostId: host.id });
  assert.equal(ticket.status, 200);
  const ws = new WebSocket(f.url.replace("http", "ws") + "/relay/client/?ticket=" + ticket.ticket);
  await once(ws, "open"); return ws;
}
test("authentication, explicit ACL, one-use pairing, and secret-free management", async t => {
  const f = await fixture(t), h = await f.register("host"), c = await f.register("client");
  assert.equal((await f.api("/api/admin/status")).status, 401);
  assert.equal((await f.api("/api/hosts", h.token)).status, 401);
  assert.deepEqual((await f.api("/api/hosts", c.token)).hosts, []);
  assert.equal((await f.api("/api/tickets", c.token, { hostId: h.id })).status, 403);
  const p = await f.api("/api/admin/pairings", f.admin, { role: "client", hostIds: [h.id] });
  const paired = await f.api("/api/devices/register", null, { role: "client", name: "paired", code: p.code });
  assert.equal(paired.status, 201);
  assert.equal((await f.api("/api/devices/register", null, { role: "client", name: "replay", code: p.code })).status, 401);
  assert.equal((await f.api("/api/hosts", paired.token)).hosts[0].id, h.id);
  const status = await f.api("/api/admin/status", f.admin);
  assert.equal(status.devices.some(d => d.token || d.tokenHash), false);
  const logs = JSON.stringify(await f.api("/api/admin/logs", f.admin));
  for (const value of [password, registrationPassword, h.token, p.code]) assert.equal(logs.includes(value), false);
});
test("real WebSockets preserve text/binary, route isolation, statistics, revocation cleanup", async t => {
  const f = await fixture(t), h = await f.register("host"), c = await f.register("client");
  await f.api("/api/admin/grants", f.admin, { clientId: c.id, hostId: h.id });
  const host = await connectHost(f, h);
  const opened = once(host, "message");
  const client = await connectClient(f, c, h);
  const msg = JSON.parse((await opened)[0].toString());
  host.send(JSON.stringify({ type: "ready", sessionId: msg.sessionId }));
  const engineOpen = once(client, "message");
  host.send(encodeFrame(msg.sessionId, "0{\"sid\":\"test\"}", false));
  const [frame, binary] = await engineOpen;
  assert.equal(binary, false); assert.equal(frame.toString(), '0{"sid":"test"}');
  const inbound = once(host, "message");
  client.send(Buffer.from([0, 255, 128, 1]));
  const data = decodeFrame((await inbound)[0]);
  assert.equal(data.sessionId, msg.sessionId); assert.equal(data.binary, true); assert.deepEqual(data.payload, Buffer.from([0, 255, 128, 1]));
  const status = await f.api("/api/admin/status", f.admin);
  assert.equal(status.sessions.length, 1); assert.equal(status.traffic.upload, 4); assert.ok(status.traffic.download > 0);
  const closed = once(client, "close");
  await f.api("/api/admin/revoke", f.admin, { id: c.id }); await closed;
  assert.equal(f.app.relay.sessions.size, 0);
  assert.equal((await f.api("/api/hosts", c.token)).status, 401);
  host.close();
});
test("credential rotation invalidates existing token and disconnects host", async t => {
  const f = await fixture(t), h = await f.register("host");
  const host = await connectHost(f, h), closed = once(host, "close");
  const result = await f.api("/api/devices/rotate", h.token, {}); await closed;
  assert.equal(result.status, 200); assert.notEqual(result.token, h.token);
  assert.equal((await f.api("/api/devices/rotate", h.token, {})).status, 401);
  const next = await connectHost(f, { ...h, token: result.token }); next.close();
});
test("password change expires all admin sessions and persists across restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "aremote-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await createApp({ dbPath: join(dir, "db.sqlite"), adminPassword: password });
  app.store.setSetting("marker", "persisted"); await app.close();
  const f = await fixture(t, { dbPath: join(dir, "db.sqlite") });
  assert.equal(f.app.store.getSetting("marker"), "persisted");
  const changed = "changed-admin-password";
  assert.equal((await f.api("/api/admin/password", f.admin, { currentPassword: password, password: changed })).status, 200);
  assert.equal((await f.api("/api/admin/status", f.admin)).status, 401);
  assert.equal((await f.api("/api/admin/login", null, { password })).status, 401);
  assert.equal((await f.api("/api/admin/login", null, { password: changed })).status, 200);
});
test("malformed frames and dead host heartbeats are cleaned up", async t => {
  const f = await fixture(t, { heartbeatMs: 30 }), h = await f.register("host");
  const host = new WebSocket(f.url.replace("http", "ws") + "/relay/host", PROTOCOL, { headers: { Authorization: `Bearer ${h.token}` }, autoPong: false });
  await once(host, "open"); await once(host, "close");
  await new Promise(r => setTimeout(r, 20)); assert.equal(f.app.relay.hosts.size, 0);
  const second = await connectHost(f, h); const closed = once(second, "close"); second.send("{bad json"); await closed;
  assert.throws(() => decodeFrame(Buffer.from("bad")));
});
test("frame size and send buffer enforce a hard memory bound", () => {
  assert.throws(() => encodeFrame("11111111-1111-1111-1111-111111111111", Buffer.alloc(LIMITS.frame + 1), true));
  let called = false;
  assert.equal(send({ readyState: 1, bufferedAmount: LIMITS.buffered, send() { called = true; } }, "x"), false);
  assert.equal(called, false);
});
