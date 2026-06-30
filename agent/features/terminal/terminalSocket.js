// Terminal Socket.IO namespace
import chalk from "chalk";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as daemonClient from "./ptyDaemonClient.js";
import { isRemoteAvailable, setupRemoteHandlers } from "../remote/remoteSocket.js";
import { isRemoteReady, setRemoteReadyChangeHandler } from "../../api/ui.js";
import { isCodespaces, getCodespaceInfo, trackConnection, trackDisconnection } from "./codespaceManager.js";
import { listSavedBufferSessions, loadSessionMetadata, loadGroups, saveSessionMetadata } from "./ptyHelper.js";
import { setupSessionHandlers } from "./handlers/SessionHandler.js";
import { setupInputHandlers } from "./handlers/InputHandler.js";
import { setupPushHandlers } from "./handlers/PushHandler.js";
import { reconcileClaudeEnv, autoEnableInstalledHooks } from "./hookManager.js";
import { markSubscriptionDisconnected } from "./pushManager.js";
import { clearNotification } from "./notificationManager.js";
import { broadcast } from "../../transport/broadcast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORANGE = chalk.rgb(230, 138, 110);
const PERSISTENCE_MODE = "daemon";
const PKG_VERSION = typeof __CLI_VERSION__ !== "undefined"
  ? __CLI_VERSION__
  : JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")).version;

// Store sessions: sessionId -> { pty, name, createdAt, buffer, daemon }
const sessions = new Map();

// Agent-managed groups (single source of truth, persisted to JSON)
const groups = new Map();            // groupId -> { id, name, createdAt }
const sessionGroups = {};            // sessionId -> groupId

// Merge live daemon sessions with persisted metadata.
// Daemon-known sessions are live; metadata-only ones survived a daemon respawn → mark needsRespawn.
async function syncDaemonSessions() {
  const daemonSessions = await daemonClient.listSessions();
  const liveById = new Map(daemonSessions.map((s) => [s.id, s]));
  const metadata = loadSessionMetadata();

  // Kill daemon orphans (live but absent from agent metadata) — leftovers from an older daemon
  for (const s of daemonSessions) {
    if (!metadata[s.id]) { try { await daemonClient.deleteSession(s.id); } catch {} }
  }

  // Agent metadata is the source of truth; daemon only reports which are live + live cwd
  sessions.clear();
  for (const [id, meta] of Object.entries(metadata)) {
    const live = liveById.get(id);
    sessions.set(id, {
      daemon: true,
      name: meta.name,
      createdAt: meta.createdAt,
      shellId: meta.shellId,
      cwd: live?.cwd || meta.cwd,
      needsRespawn: !live
    });
  }
  saveSessionMetadata(sessions);
}

export async function initializeTerminal() {
  // Load persisted groups (agent-managed, independent of daemon)
  const saved = loadGroups();
  for (const g of saved.groups) groups.set(g.id, g);
  Object.assign(sessionGroups, saved.sessionGroups);

  // Backfill scrollback env for users who enabled Claude hook before the fix
  try { reconcileClaudeEnv(); } catch {}
  // Auto-enable notify hooks for every installed AI tool (claude/codex/gemini/opencode)
  try { autoEnableInstalledHooks(); } catch {}

  if (PERSISTENCE_MODE === "daemon") {
    const connected = await daemonClient.initDaemonClient();
    if (!connected) {
      console.error("❌ Failed to connect to PTY daemon, falling back to buffer mode");
    } else {
      await syncDaemonSessions();
      // Re-sync when daemon respawns (e.g. version bump) so titles survive and lost PTYs are marked for respawn
      daemonClient.on("connected", () => { syncDaemonSessions().catch(() => {}); });
      // Silent connect
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
    daemonClient.on("output", ({ sessionId, data }) => broadcast(io, "output", { sessionId, data }));
    daemonClient.on("sessionClosed", (sessionId) => {
      sessions.delete(sessionId);
      // Drop any stale finished-badge so title count + UI stay in sync
      clearNotification(sessionId);
      broadcast(io, "sessionClosed", sessionId);
      broadcast(io, "notificationCleared", sessionId);
    });
  }

  // Build serverInfo payload (reusable for initial emit + live broadcast)
  const buildServerInfo = () => ({
    version: PKG_VERSION,
    remoteAvailable: isRemoteReady(),
    daemonMode: PERSISTENCE_MODE === "daemon" && daemonClient.isConnected(),
    platform: process.platform,
    ...getCodespaceInfo()
  });

  // Broadcast fresh serverInfo to all approved clients when remote readiness changes
  setRemoteReadyChangeHandler(() => {
    const info = buildServerInfo();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data?.approved) socket.emit("serverInfo", info);
    }
  });

  io.on("connection", (socket) => {
    trackConnection();

    socket.emit("serverInfo", buildServerInfo());

    setupSessionHandlers(socket, io, sessions, groups, sessionGroups);
    setupInputHandlers(socket, sessions);
    setupPushHandlers(socket);

    // Attach remote desktop handlers on same socket if capable (permissions checked at invoke time)
    if (isRemoteAvailable()) setupRemoteHandlers(socket, apiKey).catch((err) => {
      console.error("❌ Failed to setup remote handlers:", err.message);
    });

    socket.on("disconnect", (reason) => {
      markSubscriptionDisconnected(socket.id);
      trackDisconnection();
    });
  });
}
