import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createApp } from "../../../server/app.js";
const require = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io } = require("socket.io-client");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error("Timed out waiting for condition"); }
const adminPassword = "integration-admin-password";
const registrationPassword = "integration-registration-password";
test("original Host PTY, files and Socket.IO ACK survive reverse relay and Server restart", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "aremote-integration-"));
  let app, host, socket, output = "", serverPort;
  t.after(async () => {
    socket?.disconnect();
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await Promise.race([once(host, "exit"), sleep(6000)]); if (host.exitCode === null) host.kill("SIGKILL"); }
    try { const pid = Number(readFileSync(join(root, "host/pids/ptyDaemon.pid"), "utf8")); process.kill(pid, "SIGTERM"); } catch {}
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const start = async () => {
    app = await createApp({ dbPath: join(root, "server.sqlite"), adminPassword, registrationPassword });
    app.http.listen(serverPort || 0, "127.0.0.1"); await once(app.http, "listening"); serverPort = app.http.address().port;
  };
  await start();
  const server = `http://127.0.0.1:${serverPort}`;
  async function api(path, token, data) {
    const response = await fetch(server + path, { method: data ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  }
  const admin = await api("/api/admin/login", null, { password: adminPassword });
  const h = await api("/api/devices/register", null, { role: "host", name: "real-host", password: registrationPassword });
  const c = await api("/api/devices/register", null, { role: "client", name: "real-client", password: registrationPassword });
  await api("/api/admin/grants", admin.token, { clientId: c.id, hostId: h.id });
  const { mkdirSync } = await import("node:fs"); mkdirSync(join(root, "host"));
  writeFileSync(join(root, "host/device.json"), JSON.stringify({ server, ...h }), { mode: 0o600 });
  host = spawn(process.execPath, ["host/aremote/index.js", "start"], { cwd: resolve("."), env: { ...process.env, AREMOTE_HOME: join(root, "host"), PORT: "0", SHELL: "/bin/bash" }, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.on("data", d => output += d); host.stderr.on("data", d => output += d);
  await until(() => { if (host.exitCode !== null) throw new Error(output); return app.relay.hosts.has(h.id); });
  const connect = async () => {
    const { ticket } = await api("/api/tickets", c.token, { hostId: h.id });
    socket = io(server, { path: "/relay/client", query: { ticket }, transports: ["websocket"], reconnection: false, forceNew: true, auth: { deviceId: "spoofed-client-id" } });
    const ready = once(socket, "terminal:ready");
    await once(socket, "connect"); socket.emit("device:clientReady");
    await Promise.race([ready, sleep(15000).then(() => { throw new Error("Host not ready\n" + output); })]);
  };
  const ack = (event, ...args) => socket.timeout(10000).emitWithAck(event, ...args);
  await connect();
  assert.ok(Array.isArray(await ack("getSessions")));
  const filePath = join(root, "relay-file.txt");
  const content = "ARemote 文件往返\n";
  assert.equal((await ack("writeFile", { filePath, content })).success, true);
  assert.equal(readFileSync(filePath, "utf8"), content);
  assert.deepEqual(await ack("readFile", { filePath }), { success: true, content });
  assert.equal((await ack("readFile", { filePath: "/etc/shadow" })).success, false);
  const created = await ack("createSession", { name: "ARemote integration", shellId: "bash", cwd: root });
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal((await ack("joinSession", { sessionId: created.sessionId, cols: 100, rows: 30 })).success, true);
  let terminal = "";
  socket.on("output", data => { if (data.sessionId === created.sessionId) terminal += data.enc === "b64" ? Buffer.from(data.data, "base64").toString() : typeof data.data === "string" ? data.data : Buffer.from(data.data).toString(); });
  socket.emit("input", { sessionId: created.sessionId, data: "printf 'AREMOTE_%s\\n' 'PTY_OK'\r" });
  await until(() => terminal.includes("AREMOTE_PTY_OK"));
  const old = app; app = null; await old.close();
  socket.disconnect(); await start();
  await until(() => app.relay.hosts.has(h.id));
  await connect();
  const sessions = await ack("getSessions");
  assert.ok(sessions.some(s => (s.id || s.sessionId) === created.sessionId), JSON.stringify(sessions));
  assert.deepEqual(await ack("readFile", { filePath }), { success: true, content });
  assert.equal((await ack("joinSession", { sessionId: created.sessionId, cols: 100, rows: 30 })).success, true);
  terminal = "";
  socket.on("output", data => { if (data.sessionId === created.sessionId) terminal += data.enc === "b64" ? Buffer.from(data.data, "base64").toString() : typeof data.data === "string" ? data.data : Buffer.from(data.data).toString(); });
  socket.emit("input", { sessionId: created.sessionId, data: "printf 'AREMOTE_%s\\n' 'RESTART_OK'\r" });
  await until(() => terminal.includes("AREMOTE_RESTART_OK"));
  const deleted = await ack("deleteSession", created.sessionId);
  assert.equal(deleted.success, true);
  assert.ok(!/global signaling client started|trycloudflare\.com/.test(output), output);
});
