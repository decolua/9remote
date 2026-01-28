/**
 * PTY Daemon Client - Connects to the PTY Daemon
 * Used by main server to communicate with persistent PTY sessions
 */

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Socket path (same as daemon)
const SOCKET_DIR = path.join(os.homedir(), ".9remote");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty"
  : path.join(SOCKET_DIR, "pty-daemon.sock");

const DAEMON_SCRIPT = path.join(__dirname, "ptyDaemon.js");

// Client state
let client = null;
let connected = false;
let reconnecting = false;
let messageBuffer = "";
let requestId = 0;
const pendingRequests = new Map();
const eventHandlers = new Map();

/**
 * Generate unique request ID
 */
function nextRequestId() {
  return ++requestId;
}

/**
 * Register event handler
 */
export function on(event, handler) {
  if (!eventHandlers.has(event)) {
    eventHandlers.set(event, []);
  }
  eventHandlers.get(event).push(handler);
}

/**
 * Remove event handler
 */
export function off(event, handler) {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
}

/**
 * Emit event to handlers
 */
function emit(event, data) {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[DaemonClient] Error in ${event} handler:`, e);
      }
    }
  }
}

/**
 * Send message to daemon
 */
function send(message) {
  if (!client || !connected) {
    return false;
  }
  try {
    client.write(JSON.stringify(message) + "\n");
    return true;
  } catch (e) {
    console.error("[DaemonClient] Send error:", e);
    return false;
  }
}

/**
 * Send request and wait for response
 */
function request(message, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId();
    message.requestId = id;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Request timeout"));
    }, timeout);

    pendingRequests.set(id, { resolve, reject, timer });

    if (!send(message)) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error("Not connected to daemon"));
    }
  });
}

/**
 * Handle incoming message from daemon
 */
function handleMessage(message) {
  const { type, requestId: reqId, ...data } = message;

  // Handle response to pending request
  if (reqId && pendingRequests.has(reqId)) {
    const { resolve, timer } = pendingRequests.get(reqId);
    clearTimeout(timer);
    pendingRequests.delete(reqId);
    resolve({ type, ...data });
    return;
  }

  // Handle events
  switch (type) {
    case "output":
      emit("output", {
        sessionId: data.sessionId,
        data: Buffer.from(data.data, "base64")
      });
      break;

    case "sessionClosed":
      emit("sessionClosed", data.sessionId);
      break;

    case "sessionRenamed":
      emit("sessionRenamed", { sessionId: data.sessionId, name: data.name });
      break;

    case "pong":
      // Heartbeat response
      break;

    default:
      console.log("[DaemonClient] Unknown message:", type);
  }
}

/**
 * Check if daemon is running
 */
function isDaemonRunning() {
  if (process.platform === "win32") {
    // Windows: try to connect
    return new Promise((resolve) => {
      const testClient = net.connect(SOCKET_PATH);
      testClient.on("connect", () => {
        testClient.destroy();
        resolve(true);
      });
      testClient.on("error", () => {
        resolve(false);
      });
    });
  } else {
    return Promise.resolve(fs.existsSync(SOCKET_PATH));
  }
}

/**
 * Start daemon process
 */
async function startDaemon() {
  console.log("[DaemonClient] Starting PTY Daemon...");

  const daemon = spawn("node", [DAEMON_SCRIPT], {
    detached: true,
    stdio: "ignore",
    cwd: __dirname
  });

  daemon.unref();

  // Wait for daemon to start
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isDaemonRunning()) {
      console.log("[DaemonClient] Daemon started, PID:", daemon.pid);
      return true;
    }
  }

  console.error("[DaemonClient] Failed to start daemon");
  return false;
}

/**
 * Connect to daemon
 */
async function connectToDaemon() {
  if (connected || reconnecting) return;
  reconnecting = true;

  try {
    // Check if daemon is running
    if (!(await isDaemonRunning())) {
      // Start daemon
      if (!(await startDaemon())) {
        reconnecting = false;
        return false;
      }
    }

    // Connect
    return new Promise((resolve) => {
      client = net.connect(SOCKET_PATH);

      client.on("connect", () => {
        console.log("[DaemonClient] Connected to daemon");
        connected = true;
        reconnecting = false;
        emit("connected");
        resolve(true);
      });

      client.on("data", (chunk) => {
        messageBuffer += chunk.toString();
        const lines = messageBuffer.split("\n");
        messageBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              handleMessage(JSON.parse(line));
            } catch (e) {
              console.error("[DaemonClient] Invalid message:", line);
            }
          }
        }
      });

      client.on("close", () => {
        console.log("[DaemonClient] Disconnected from daemon");
        connected = false;
        client = null;
        emit("disconnected");
        
        // Auto-reconnect after 2s
        setTimeout(() => {
          if (!connected && !reconnecting) {
            connectToDaemon();
          }
        }, 2000);
      });

      client.on("error", (err) => {
        console.error("[DaemonClient] Connection error:", err.message);
        reconnecting = false;
        resolve(false);
      });
    });
  } catch (e) {
    console.error("[DaemonClient] Connect error:", e);
    reconnecting = false;
    return false;
  }
}

/**
 * Initialize daemon client
 */
export async function initDaemonClient() {
  return connectToDaemon();
}

/**
 * Check if connected
 */
export function isConnected() {
  return connected;
}

/**
 * List sessions from daemon
 */
export async function listSessions() {
  const result = await request({ type: "listSessions" });
  return result.sessions || [];
}

/**
 * Create new session
 */
export async function createSession(name, cols = 80, rows = 24) {
  const sessionId = `session-${Date.now()}`;
  const result = await request({
    type: "createSession",
    sessionId,
    name,
    cols,
    rows
  });
  return result;
}

/**
 * Join session (get buffered output)
 */
export async function joinSession(sessionId) {
  const result = await request({ type: "joinSession", sessionId });
  return result;
}

/**
 * Send input to session
 */
export function sendInput(sessionId, data) {
  return send({ type: "input", sessionId, data });
}

/**
 * Resize session
 */
export function resizeSession(sessionId, cols, rows) {
  return send({ type: "resize", sessionId, cols, rows });
}

/**
 * Delete session
 */
export async function deleteSession(sessionId) {
  const result = await request({ type: "deleteSession", sessionId });
  return result;
}

/**
 * Rename session
 */
export async function renameSession(sessionId, name) {
  const result = await request({ type: "renameSession", sessionId, name });
  return result;
}
