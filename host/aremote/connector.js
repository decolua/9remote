import WebSocket from "ws";
import { PROTOCOL, CLOSE_CODES, LIMITS, send, control, encodeFrame, decodeFrame } from "../../shared/relay/protocol.js";
import { issueRelayIdentity, removeRelayIdentity } from "./relayIdentity.js";
export function connectRelay({ serverUrl, token, localPort, onStatus = () => {}, retryMinMs = 1000, retryMaxMs = 30000 }) {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Server URL must be an HTTP(S) origin");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote servers require HTTPS");
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Invalid local port");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/relay/host";
  let stopped = false, retry, heartbeat, remote, attempt = 0;
  const sessions = new Map();
  const closeSession = (id, notify = true) => {
    const s = sessions.get(id); if (!s) return;
    sessions.delete(id); removeRelayIdentity(s.identity); s.ws.terminate();
    if (notify) send(remote, JSON.stringify({ type: "close", sessionId: id }));
  };
  function connect() {
    if (stopped) return;
    const ws = remote = new WebSocket(url, PROTOCOL, { headers: { Authorization: `Bearer ${token}` }, maxPayload: LIMITS.frame + 37, perMessageDeflate: false, handshakeTimeout: 10000 });
    let lastPing = Date.now(), openedAt = 0;
    ws.on("open", () => {
      openedAt = Date.now(); onStatus("online");
      heartbeat = setInterval(() => { if (Date.now() - lastPing > LIMITS.heartbeatMs * 3) ws.terminate(); }, LIMITS.heartbeatMs);
      heartbeat.unref();
    });
    ws.on("ping", () => { lastPing = Date.now(); });
    ws.on("message", (raw, binary) => {
      try {
        if (binary) {
          const m = decodeFrame(raw), s = sessions.get(m.sessionId);
          if (s && !send(s.ws, m.payload, m.binary)) closeSession(m.sessionId);
          return;
        }
        const m = control(raw);
        if (m.type === "close") return closeSession(m.sessionId, false);
        if (m.type !== "open" || sessions.has(m.sessionId) || sessions.size >= LIMITS.sessions) throw new Error("Invalid session open");
        const identity = issueRelayIdentity(m.clientId, m.sessionId);
        const local = new WebSocket(`ws://127.0.0.1:${localPort}/socket.io/?EIO=4&transport=websocket`, { headers: { "x-aremote-session": identity }, maxPayload: LIMITS.frame, perMessageDeflate: false, handshakeTimeout: LIMITS.openTimeoutMs });
        sessions.set(m.sessionId, { ws: local, identity });
        local.on("open", () => { if (!send(ws, JSON.stringify({ type: "ready", sessionId: m.sessionId }))) closeSession(m.sessionId); });
        local.on("message", (data, isBinary) => { if (!send(ws, encodeFrame(m.sessionId, data, isBinary), true)) closeSession(m.sessionId); });
        local.on("error", () => closeSession(m.sessionId));
        local.on("close", () => closeSession(m.sessionId));
      } catch { ws.close(1008, "Invalid relay message"); }
    });
    ws.on("error", () => { onStatus("connection-error"); });
    ws.on("close", (code) => {
      clearInterval(heartbeat); for (const id of [...sessions.keys()]) closeSession(id, false);
      if (stopped) return;
      if (code === CLOSE_CODES.credentials) { onStatus("credentials-revoked"); return; }
      if (code === CLOSE_CODES.replaced) { onStatus("host-replaced"); return; }
      if (openedAt && Date.now() - openedAt > 30000) attempt = 0;
      const delay = Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(attempt++, 10)) * (0.8 + Math.random() * 0.4);
      onStatus("reconnecting"); retry = setTimeout(connect, delay);
    });
  }
  connect();
  return { close() { stopped = true; clearTimeout(retry); clearInterval(heartbeat); for (const id of [...sessions.keys()]) closeSession(id, false); remote?.terminate(); }, get sessionCount() { return sessions.size; } };
}
