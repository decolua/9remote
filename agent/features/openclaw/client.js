import { WebSocket } from "ws";
import { randomUUID, sign as edSign, createPublicKey } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";a

const OPENCLAW_DIR = `${homedir()}/.openclaw`;
const IDENTITY_PATH = `${OPENCLAW_DIR}/identity/device.json`;
const CONFIG_PATH = `${OPENCLAW_DIR}/openclaw.json`;
const SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const ROLE = "operator";
const PLATFORM = "node";
const BACKOFF_STEPS = [2000, 4000, 8000, 30000];
const TERMINAL_STATES = new Set(["final", "aborted", "error"]);

// ─── Identity helpers ────────────────────────────────────────────────────────

function loadIdentity() {
  const raw = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
  return { deviceId: raw.deviceId, privateKeyPem: raw.privateKeyPem, publicKeyPem: raw.publicKeyPem };
}

// Read gateway token from ~/.openclaw/openclaw.json (gateway.auth.token)
function loadGatewayToken() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cfg.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

// Export Ed25519 SPKI DER → last 32 bytes = raw key → base64url
function publicKeyRawBase64Url(pem) {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return der.slice(-32).toString("base64url");
}

function signPayload(privateKeyPem, payload) {
  return edSign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64url");
}

function buildPayloadV3({ deviceId, signedAtMs, token, nonce }) {
  return [
    "v3", deviceId, CLIENT_ID, CLIENT_MODE, ROLE,
    SCOPES.join(","), String(signedAtMs), token ?? "",
    nonce, PLATFORM, "",
  ].join("|");
}

// ─── Singleton state ─────────────────────────────────────────────────────────

let _client = null;           // { request, close, chatHandlers }
let _connected = false;
let _reconnectAttempt = 0;
let _reconnectTimer = null;
let _identity = null;

// Shared event buffer and handler map (survive reconnects)
const chatHandlers = new Map();
const chatEventBuffer = new Map(); // runId → Event[]

// Raw event listeners (eventName → handler[])
const rawEventListeners = new Map();

function registerRawEventListener(eventName, handler) {
  if (!rawEventListeners.has(eventName)) rawEventListeners.set(eventName, []);
  rawEventListeners.get(eventName).push(handler);
}

// ─── Internal WS builder ─────────────────────────────────────────────────────

function buildWs(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();

    const send = (frame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    const request = (method, params = {}) => {
      const id = randomUUID();
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        send({ type: "req", id, method, params });
      });
    };

    const dispatchChatEvent = (payload) => {
      const { runId } = payload;
      if (!runId) return;

      const handler = chatHandlers.get(runId);
      if (handler) {
        // Flush buffered events before current one
        const buffered = chatEventBuffer.get(runId) || [];
        chatEventBuffer.delete(runId);
        buffered.forEach((e) => handler(e));
        handler(payload);
        if (TERMINAL_STATES.has(payload.state)) chatHandlers.delete(runId);
      } else {
        if (!chatEventBuffer.has(runId)) chatEventBuffer.set(runId, []);
        chatEventBuffer.get(runId).push(payload);
      }
    };

    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Step 1: receive challenge → sign → send connect
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        const signedAtMs = Date.now();
        const payload = buildPayloadV3({ deviceId: _identity.deviceId, signedAtMs, token, nonce });
        const signature = signPayload(_identity.privateKeyPem, payload);
        const publicKey = publicKeyRawBase64Url(_identity.publicKeyPem);

        send({
          type: "req",
          id: randomUUID(),
          method: "connect",
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: CLIENT_ID, version: "1.0.0", platform: PLATFORM, mode: CLIENT_MODE },
            role: ROLE,
            scopes: SCOPES,
            auth: { token },
            device: { id: _identity.deviceId, publicKey, signature, signedAt: signedAtMs, nonce },
          },
        });
        return;
      }

      // Step 2: hello-ok → authenticated
      if (frame.type === "res" && frame.payload?.type === "hello-ok") {
        resolve({ request, close: () => ws.close(), onEvent: registerRawEventListener });
        return;
      }

      if (frame.type === "res") {
        // Log all errors for debugging
        if (!frame.ok) {
          console.error("[openclaw-client] RPC error:", frame.error);
        }
        
        const h = pending.get(frame.id);
        if (h) {
          pending.delete(frame.id);
          frame.ok ? h.resolve(frame.payload) : h.reject(new Error(frame.error?.message || "Request failed"));
        }
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        dispatchChatEvent(frame.payload);
        return;
      }

      // Dispatch raw events to registered listeners
      if (frame.type === "event" && frame.event) {
        const listeners = rawEventListeners.get(frame.event);
        if (listeners) listeners.forEach((fn) => fn(frame.payload));
      }
    });

    ws.on("error", reject);

    ws.on("close", (code) => {
      _connected = false;
      _client = null;

      // Reject all in-flight requests
      for (const { reject: rej } of pending.values()) rej(new Error(`WS closed (${code})`));
      pending.clear();

      // Schedule reconnect only on unexpected close
      if (code !== 1000) scheduleReconnect();
    });
  });
}

// ─── Reconnect logic ─────────────────────────────────────────────────────────

function scheduleReconnect() {
  if (_reconnectTimer) return;
  const delay = BACKOFF_STEPS[Math.min(_reconnectAttempt, BACKOFF_STEPS.length - 1)];
  _reconnectAttempt++;
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    try {
      await connectOpenClaw();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function connectOpenClaw() {
  const url = process.env.OPENCLAW_URL || `ws://127.0.0.1:18789`;
  const token = process.env.OPENCLAW_TOKEN || loadGatewayToken();
  
  if (!url) throw new Error("OPENCLAW_URL is not set");

  if (!_identity) {
    _identity = loadIdentity();
  }

  _client = await buildWs(url, token);
  _connected = true;
  _reconnectAttempt = 0;
  console.log("[openclaw] ✅ Connected");
}

export async function sendChat(sessionKey, message, { idempotencyKey, attachments } = {}) {
  console.log("[openclaw-client] sendChat called:", { sessionKey, messageLength: message?.length, idempotencyKey });
  const params = { sessionKey, message };
  if (idempotencyKey) params.idempotencyKey = idempotencyKey;
  if (attachments) params.attachments = attachments;
  try {
    const res = await _client.request("chat.send", params);
    console.log("[openclaw-client] sendChat response:", res);
    return res.runId;
  } catch (err) {
    console.error("[openclaw-client] sendChat error:", err.message);
    throw err;
  }
}

export async function abortChat(sessionKey) {
  return _client.request("chat.abort", { sessionKey });
}

export async function getChatHistory(sessionKey, limit = 20) {
  const res = await _client.request("chat.history", { sessionKey, limit });
  return res.messages ?? res;
}

export async function listAgents() {
  const res = await _client.request("agents.list", {});
  return res.agents ?? res;
}

// Register handler for streaming events of a runId. Auto-cleanup on terminal state.
export function onChatEvent(runId, handler) {
  chatHandlers.set(runId, handler);

  // Flush any buffered events that arrived before handler registration
  const buffered = chatEventBuffer.get(runId) || [];
  if (buffered.length > 0) {
    chatEventBuffer.delete(runId);
    buffered.forEach((e) => {
      handler(e);
      if (TERMINAL_STATES.has(e.state)) chatHandlers.delete(runId);
    });
  }
}

export function isConnected() {
  return _connected;
}

export function getClient() {
  return _client;
}
