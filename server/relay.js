import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { PROTOCOL, LIMITS, control, encodeFrame, decodeFrame, send } from "../shared/relay/protocol.js";
import { bearer } from "./auth.js";
export function attachRelay(http, store, tickets, { heartbeatMs = LIMITS.heartbeatMs } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frame + 37, perMessageDeflate: false });
  const hosts = new Map(), sessions = new Map(), sockets = new Set();
  function closeSession(id, reason = "closed") {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearTimeout(s.timer);
    send(s.host, JSON.stringify({ type: "close", sessionId: id }));
    s.client.close(1012, reason);
    store.log(reason, s.clientId, id);
  }
  function dropDevice(id) {
    hosts.get(id)?.close(4003, "Device credentials changed");
    hosts.delete(id);
    for (const [sid, s] of sessions) if (s.clientId === id || s.hostId === id) closeSession(sid, "device-disabled");
    for (const [key, t] of tickets) if (t.clientId === id || t.hostId === id) tickets.delete(key);
  }
  function revokeGrant(clientId, hostId) {
    for (const [id, s] of sessions) if (s.clientId === clientId && s.hostId === hostId) closeSession(id, "access-revoked");
    for (const [key, t] of tickets) if (t.clientId === clientId && t.hostId === hostId) tickets.delete(key);
  }
  http.on("upgrade", (req, socket, head) => {
    const reject = (code) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return reject(400); }
    if (sockets.size >= 2048) return reject(503);
    if (url.pathname === "/relay/host") {
      const device = store.device(bearer(req));
      if (!device || device.role !== "host") return reject(401);
      if (req.headers["sec-websocket-protocol"] !== PROTOCOL) return reject(400);
      wss.handleUpgrade(req, socket, head, (ws) => onHost(ws, device));
      return;
    }
    if (url.pathname !== "/relay/client/") return reject(404);
    const key = url.searchParams.get("ticket");
    const ticket = tickets.get(key);
    tickets.delete(key);
    if (!ticket || ticket.expiresAt < Date.now() || !store.allowed(ticket.clientId, ticket.hostId)) return reject(401);
    const host = hosts.get(ticket.hostId);
    if (!host || host.readyState !== 1) return reject(503);
    if ([...sessions.values()].filter(s => s.hostId === ticket.hostId).length >= LIMITS.sessions) return reject(429);
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, ticket, host));
  });
  function track(ws, deviceId) {
    sockets.add(ws); ws.alive = true;
    store.seen(deviceId);
    ws.on("pong", () => { ws.alive = true; store.seen(deviceId); });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => { sockets.delete(ws); store.seen(deviceId); });
  }
  function onHost(ws, device) {
    dropDevice(device.id);
    hosts.set(device.id, ws); track(ws, device.id);
    store.log("host-connected", device.id);
    ws.on("message", (raw, binary) => {
      try {
        if (!binary) {
          const m = control(raw), s = sessions.get(m.sessionId);
          if (!s || s.host !== ws) return;
          if (m.type === "ready") { s.ready = true; clearTimeout(s.timer); }
          else if (m.type === "close") closeSession(m.sessionId, "host-session-closed");
          else ws.close(1008, "Invalid message direction");
          return;
        }
        const m = decodeFrame(raw), s = sessions.get(m.sessionId);
        if (!s || s.host !== ws || !s.ready) return;
        if (!send(s.client, m.payload, m.binary)) return closeSession(m.sessionId, "backpressure");
        store.traffic(0, m.payload.length);
      } catch { ws.close(1008, "Invalid relay frame"); }
    });
    ws.on("close", () => {
      if (hosts.get(device.id) === ws) hosts.delete(device.id);
      for (const [id, s] of sessions) if (s.host === ws) closeSession(id, "host-offline");
      store.log("host-disconnected", device.id);
    });
  }
  function onClient(ws, ticket, host) {
    const id = randomUUID();
    track(ws, ticket.clientId);
    const s = { host, client: ws, hostId: ticket.hostId, clientId: ticket.clientId, ready: false, createdAt: Date.now() };
    sessions.set(id, s);
    s.timer = setTimeout(() => closeSession(id, "open-timeout"), LIMITS.openTimeoutMs);
    if (!send(host, JSON.stringify({ type: "open", sessionId: id, clientId: ticket.clientId }))) closeSession(id, "backpressure");
    store.log("session-open", ticket.clientId, id);
    ws.on("message", (payload, binary) => {
      if (!sessions.has(id)) return;
      if (!s.ready) return closeSession(id, "session-not-ready");
      if (payload.length > LIMITS.frame) return closeSession(id, "frame-too-large");
      if (!send(host, encodeFrame(id, payload, binary), true)) return closeSession(id, "backpressure");
      store.traffic(payload.length, 0);
    });
    ws.on("close", () => closeSession(id, "client-disconnected"));
  }
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
    for (const [key, t] of tickets) if (t.expiresAt < Date.now()) tickets.delete(key);
  }, heartbeatMs);
  heartbeat.unref();
  return {
    hosts, sessions, dropDevice, revokeGrant,
    online(id) { return hosts.has(id) || [...sessions.values()].some(s => s.clientId === id); },
    close() { clearInterval(heartbeat); for (const id of [...sessions.keys()]) closeSession(id, "server-shutdown"); return new Promise(resolve => { wss.close(resolve); for (const ws of sockets) ws.terminate(); }); }
  };
}
