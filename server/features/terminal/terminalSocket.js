// Terminal Socket.IO namespace
import chalk from "chalk";
import * as daemonClient from "./ptyDaemonClient.js";
import { isRemoteAvailable, setupRemoteHandlers } from "../remote/remoteSocket.js";
import { isCodespaces, getCodespaceInfo, trackConnection, trackDisconnection } from "./codespaceManager.js";
import { listSavedBufferSessions, loadSessionMetadata } from "./ptyHelper.js";
import { setupSessionHandlers } from "./handlers/SessionHandler.js";
import { setupInputHandlers } from "./handlers/InputHandler.js";
import { setupPushHandlers } from "./handlers/PushHandler.js";
import { markSubscriptionDisconnected } from "./pushManager.js";

const ORANGE = chalk.rgb(230, 138, 110);
const PERSISTENCE_MODE = "daemon";

// Store sessions: sessionId -> { pty, name, createdAt, buffer, daemon }
const sessions = new Map();

export async function initializeTerminal() {
  if (PERSISTENCE_MODE === "daemon") {
    const connected = await daemonClient.initDaemonClient();
    if (!connected) {
      console.error("❌ Failed to connect to PTY daemon, falling back to buffer mode");
    } else {
      const daemonSessions = await daemonClient.listSessions();
      for (const s of daemonSessions) {
        sessions.set(s.id, { daemon: true, name: s.name, createdAt: s.createdAt });
      }
      const count = daemonSessions.length;
      console.log(ORANGE(count > 0 ? `✅ Connected to daemon with ${count} session(s)` : "✅ Connected to PTY daemon"));
      return;
    }
  }

  // Buffer mode (fallback)
  console.log("📦 Buffer persistence mode - scrollback enabled");
  const savedSessions = listSavedBufferSessions();
  const metadata = loadSessionMetadata();
  for (const sessionId of savedSessions) {
    const meta = metadata[sessionId] || {};
    sessions.set(sessionId, {
      pty: null,
      name: meta.name || `Terminal ${sessions.size + 1}`,
      createdAt: meta.createdAt || Date.now(),
      buffer: [],
      needsRestore: true
    });
    console.log(`🔄 Found saved session: ${sessionId}`);
  }
  if (savedSessions.length > 0) console.log(`✅ Found ${savedSessions.length} saved session(s)`);
}

export function setupTerminalSocket(io, apiKey) {
  // Forward daemon events to all socket clients
  if (PERSISTENCE_MODE === "daemon") {
    daemonClient.on("output", ({ sessionId, data }) => io.emit("output", { sessionId, data }));
    daemonClient.on("sessionClosed", (sessionId) => { sessions.delete(sessionId); io.emit("sessionClosed", sessionId); });
    daemonClient.on("sessionRenamed", ({ sessionId, name }) => {
      const s = sessions.get(sessionId);
      if (s) s.name = name;
      io.emit("session-renamed", { sessionId, name });
    });
  }

  io.on("connection", (socket) => {
    const mode = socket.handshake.auth?.connectionMode || "tunnel";
    console.log(`📟 Terminal client connected: ${socket.id} [${mode}]`);
    trackConnection();

    socket.emit("serverInfo", {
      remoteAvailable: isRemoteAvailable(),
      daemonMode: PERSISTENCE_MODE === "daemon" && daemonClient.isConnected(),
      platform: process.platform,
      ...getCodespaceInfo()
    });

    setupSessionHandlers(socket, io, sessions);
    setupInputHandlers(socket, sessions);
    setupPushHandlers(socket);

    // Attach remote desktop handlers on same socket if available
    if (isRemoteAvailable()) setupRemoteHandlers(socket, apiKey).catch((err) => {
      console.error("❌ Failed to setup remote handlers:", err.message);
    });

    socket.on("disconnect", () => {
      console.log(`📟 Terminal client disconnected: ${socket.id}`);
      markSubscriptionDisconnected(socket.id);
      trackDisconnection();
    });
  });
}
