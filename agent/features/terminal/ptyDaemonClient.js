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

// Daemon script locations
// - Source: dev mode (server/features/terminal/ptyDaemon.js)
// - Dist: package mode (dist/ptyDaemon.cjs)
const DAEMON_SCRIPT_SOURCE = path.join(__dirname, "ptyDaemon.js");
const DAEMON_SCRIPT_DIST = path.join(__dirname, "ptyDaemon.cjs");

// Runtime copy location — daemon runs from here so it never locks files
// inside node_modules/9remote. That lock is what makes `npm i -g 9remote@latest`
// fail with EBUSY on Windows when the daemon is still alive.
const DAEMON_RUNTIME_DIR = path.join(SOCKET_DIR, "daemon");

function getCliVersion() {
  if (typeof __CLI_VERSION__ !== "undefined") return __CLI_VERSION__;
  try {
    // Walk up from agent/features/terminal → agent/ → find package.json
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * Copy a directory tree recursively. Node 16+ supports fs.cpSync but we use
 * a hand-rolled version to stay compatible with the 14.x envs we still see
 * in the wild (some GitHub Codespaces images).
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Find the node-pty package folder by walking up from the daemon script.
 * Returns null if not found (caller falls back to running from original path).
 */
function findNodePtyDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules", "node-pty");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Prepare a self-contained daemon folder at ~/.9remote/daemon/v<version>/.
 * Layout:
 *   v<version>/
 *     ptyDaemon.cjs            ← copied from source/dist
 *     node_modules/node-pty/   ← full package (lib + prebuild for this platform)
 *
 * Returns { script, cwd } pointing at the copy, or null if copy failed
 * (caller falls back to running from original path).
 */
// Remove daemon version folders other than current — only if daemon is not alive.
// Prevents disk bloat from accumulated upgrades while keeping live sessions safe.
function cleanupOldDaemonVersions(currentVersion) {
  try {
    if (!fs.existsSync(DAEMON_RUNTIME_DIR)) return;
    // Read PID lazy so we don't import pids.js into the daemon process itself
    const pidFile = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");
    let alive = false;
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch {}
      }
    } catch {}
    if (alive) return;
    for (const name of fs.readdirSync(DAEMON_RUNTIME_DIR)) {
      if (name === `v${currentVersion}`) continue;
      try { fs.rmSync(path.join(DAEMON_RUNTIME_DIR, name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function prepareDaemonCopy(sourceScript) {
  const version = getCliVersion();
  cleanupOldDaemonVersions(version);
  const runtimeDir = path.join(DAEMON_RUNTIME_DIR, `v${version}`);
  const copiedScript = path.join(runtimeDir, path.basename(sourceScript));
  const copiedPtyDir = path.join(runtimeDir, "node_modules", "node-pty");

  // Already prepared — skip work
  if (fs.existsSync(copiedScript) && fs.existsSync(copiedPtyDir)) {
    return { script: copiedScript, cwd: runtimeDir };
  }

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Copy daemon script
    fs.copyFileSync(sourceScript, copiedScript);

    // Locate node-pty relative to the source script so this works in both dev
    // (agent/features/terminal/) and bundled (dist/) layouts.
    const ptyDir = findNodePtyDir(path.dirname(sourceScript));
    if (!ptyDir) return null;
    copyDirSync(ptyDir, copiedPtyDir);

    return { script: copiedScript, cwd: runtimeDir };
  } catch {
    return null;
  }
}

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
 * Check if daemon is running by attempting to connect
 */
function isDaemonRunning() {
  return new Promise((resolve) => {
    const testClient = net.connect(SOCKET_PATH);
    const timeout = setTimeout(() => {
      testClient.destroy();
      resolve(false);
    }, 1000);
    
    testClient.on("connect", () => {
      clearTimeout(timeout);
      testClient.destroy();
      resolve(true);
    });
    
    testClient.on("error", () => {
      clearTimeout(timeout);
      // Remove stale socket file on Unix
      if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch (e) {
          // Ignore
        }
      }
      resolve(false);
    });
  });
}

/**
 * Get daemon script path.
 *
 * Strategy: copy the daemon + its node-pty dependency to ~/.9remote/daemon/
 * so node.exe only ever locks files under the user's home directory. This
 * lets `npm i -g 9remote@latest` rename node_modules\9remote on Windows even
 * while the daemon is still running.
 *
 * Falls back to the original location if the copy fails (e.g. readonly home).
 */
function getDaemonScript() {
  // Ensure socket directory exists
  if (!fs.existsSync(SOCKET_DIR)) {
    fs.mkdirSync(SOCKET_DIR, { recursive: true });
  }

  // Pick source: dev (source) preferred over dist (bundled).
  const sourceScript = fs.existsSync(DAEMON_SCRIPT_SOURCE)
    ? DAEMON_SCRIPT_SOURCE
    : (fs.existsSync(DAEMON_SCRIPT_DIST) ? DAEMON_SCRIPT_DIST : null);

  if (!sourceScript) {
    console.error("[DaemonClient] ❌ Daemon script not found");
    return null;
  }

  // Try runtime copy first — this is what unblocks `npm i -g 9remote@latest`.
  const copy = prepareDaemonCopy(sourceScript);
  if (copy) return copy;

  // Fallback: run from original location (old behaviour). Update will still
  // EBUSY on Windows in this case, but the daemon at least works.
  return { script: sourceScript, cwd: __dirname };
}

/**
 * Start daemon process
 */
async function startDaemon() {
  // Ensure socket directory exists
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
    } catch (e) {
      console.error("[DaemonClient] Failed to create socket directory:", e.message);
      return false;
    }
  }

  const daemonInfo = getDaemonScript();
  if (!daemonInfo) {
    return false;
  }

  const { script, cwd } = daemonInfo;

  // Capture daemon output for debugging — co-located with agent.log under logs/
  const logDir = path.join(SOCKET_DIR, "logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, "daemon.log");
  let logFd;

  try {
    logFd = fs.openSync(logPath, "w"); // Use 'w' to clear old logs
  } catch (e) {
    console.error("[DaemonClient] Failed to open log file:", e.message);
    logFd = "ignore";
  }
  
  const daemon = spawn("node", [script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: cwd // Run from script's directory so it can find node_modules
  });

  daemon.unref();
  
  // Close log fd after spawn
  if (typeof logFd === "number") {
    try {
      fs.closeSync(logFd);
    } catch (e) {
      // Ignore close errors
    }
  }

  // Wait for daemon to start
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isDaemonRunning()) {
      return true;
    }
  }

  // Show daemon log if failed
  console.error("[DaemonClient] ❌ Failed to start daemon");
  try {
    const log = fs.readFileSync(logPath, "utf8");
    if (log.trim()) {
      console.error("[DaemonClient] Daemon log:");
      console.error(log);
    }
  } catch (e) {
    // Ignore
  }
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
        console.error("[DaemonClient] ❌ Failed to start daemon");
        reconnecting = false;
        return false;
      }
    }

    // Connect
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error("[DaemonClient] ❌ Connection timeout after 5s");
        if (client) client.destroy();
        reconnecting = false;
        resolve(false);
      }, 5000);

      client = net.connect(SOCKET_PATH);

      client.on("connect", () => {
        clearTimeout(timeout);
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
        clearTimeout(timeout);
        console.error("[DaemonClient] ❌ Connection error:", err.message);
        console.error("[DaemonClient] Error code:", err.code);
        reconnecting = false;
        resolve(false);
      });
    });
  } catch (e) {
    console.error("[DaemonClient] ❌ Connect error:", e);
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
