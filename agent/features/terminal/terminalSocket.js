// Terminal Socket.IO namespace
import chalk from "chalk";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as daemonClient from "./ptyDaemonClient.js";

import { isRemoteAvailable, setupRemoteHandlers } from "../remote/remoteSocket.js";
import { isRemoteReady, setRemoteReadyChangeHandler, getUpdateInfo } from "../../api/ui.js";
import { isCodespaces, getCodespaceInfo, trackConnection, trackDisconnection } from "./codespaceManager.js";
import { listSavedBufferSessions, loadSessionMetadata, loadGroups, loadWorkspaces, saveWorkspaces, saveSessionMetadata, saveSessionMetadataRaw } from "./ptyHelper.js";
import { migrateGroupsToWorkspaces, assignOrphanSessions } from "./workspaceMigration.js";
import { setupSessionHandlers } from "./handlers/SessionHandler.js";
import { setupInputHandlers } from "./handlers/InputHandler.js";
import { setupPushHandlers } from "./handlers/PushHandler.js";
import { reconcileClaudeEnv, autoEnableInstalledHooks } from "./hookManager.js";
import { markSubscriptionDisconnected } from "./pushManager.js";
import { clearNotification } from "./notificationManager.js";
import { touchWorking, startReaper, getStatuses } from "./statusManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { nextSeq, currentSeq, cacheChunk, clearSession as clearSeqSession } from "./seqStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORANGE = chalk.rgb(230, 138, 110);
const PERSISTENCE_MODE = "daemon";
const PKG_VERSION = typeof __CLI_VERSION__ !== "undefined"
  ? __CLI_VERSION__
  : JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")).version;

// Store sessions: sessionId -> { pty, name, createdAt, buffer, daemon }
const sessions = new Map();

// Agent-managed workspaces (single source of truth, persisted to JSON)
const workspaces = new Map();        // workspaceId -> { id, name, path, createdAt }
const sessionWorkspaces = {};        // sessionId -> workspaceId
const sessionOrder = [];             // ordered sessionIds (drag reorder within workspace)

// sessionId -> workspace root, produced once by the group->workspace migration. Applied
// when syncDaemonSessions rebuilds the session map from metadata.
let migratedSessionPaths = {};

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
      workspacePath: meta.workspacePath ?? migratedSessionPaths[id] ?? null,
      // Restore last client size so a respawned PTY (after agent/daemon restart)
      // inherits the real terminal size instead of falling back to 80×24.
      lastCols: meta.cols ?? null,
      lastRows: meta.rows ?? null,
      needsRespawn: !live
    });
  }
  saveSessionMetadata(sessions);
}

// Give every workspace-less terminal a home, by the directory it actually runs in. Runs
// after each session sync, not once at install: terminals made against an older agent,
// or left over from a deleted workspace, keep turning up.
function adoptOrphanSessions() {
  const { assignments, created } = assignOrphanSessions({
    sessions, workspaces: [...workspaces.values()], sessionWorkspaces
  });
  if (!Object.keys(assignments).length) return;

  for (const w of created) workspaces.set(w.id, w);
  for (const [sessionId, workspaceId] of Object.entries(assignments)) {
    sessionWorkspaces[sessionId] = workspaceId;
    const session = sessions.get(sessionId);
    // Pin it too, so the grouping survives a later `cd`.
    if (session && !session.workspacePath) session.workspacePath = workspaces.get(workspaceId)?.path || null;
  }
  saveWorkspaces(workspaces, sessionWorkspaces, sessionOrder);
  saveSessionMetadata(sessions);
  console.log(ORANGE(
    `📁 Grouped ${Object.keys(assignments).length} loose terminal(s)` +
    (created.length ? ` into ${created.length} new workspace(s)` : "")
  ));
}

// Live sessions with the path each is rooted at. Read by the git handlers so removing a
// worktree can warn about terminals still running inside it.
export function listSessionRoots() {
  return [...sessions.entries()].map(([id, s]) => ({
    id, name: s.name, workspacePath: s.workspacePath || null, cwd: s.cwd || null
  }));
}

export async function initializeTerminal() {
  // Load persisted workspaces (agent-managed, independent of daemon).
  // First run after the group->workspace change: migrate from terminalGroups.json,
  // deriving a workspace from each ungrouped session's nearest git root.
  let saved = loadWorkspaces();
  if (!saved) {
    const metadata = loadSessionMetadata();
    const legacy = loadGroups();
    saved = migrateGroupsToWorkspaces(legacy, metadata);
    const migrated = new Map(saved.workspaces.map((w) => [w.id, w]));
    saveWorkspaces(migrated, saved.sessionWorkspaces, saved.sessionOrder);
    // Pin each migrated session to its workspace root, so a `cd` afterwards cannot move
    // it between workspaces. Written back to sessions.json before the daemon sync reads it.
    migratedSessionPaths = saved.sessionPaths || {};
    if (Object.keys(migratedSessionPaths).length) {
      for (const [id, wsPath] of Object.entries(migratedSessionPaths)) {
        if (metadata[id]) metadata[id].workspacePath = wsPath;
      }
      saveSessionMetadataRaw(metadata);
    }
    // A group with no surviving terminals has no directory to infer, so it is dropped —
    // say so rather than let the name vanish silently.
    const keptGroups = (legacy.groups || []).filter((g) => saved.workspaces.some((w) => w.id === g.id)).length;
    const droppedGroups = (legacy.groups || []).length - keptGroups;
    if (saved.workspaces.length || droppedGroups) {
      console.log(ORANGE(
        `📁 Migrated ${saved.workspaces.length} workspace(s) from terminal groups` +
        (droppedGroups ? `, dropped ${droppedGroups} empty group(s)` : "")
      ));
    }
  }
  for (const w of saved.workspaces) workspaces.set(w.id, w);
  Object.assign(sessionWorkspaces, saved.sessionWorkspaces);
  sessionOrder.push(...saved.sessionOrder);

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
      adoptOrphanSessions();
      // Re-sync when daemon respawns (e.g. version bump) so titles survive and lost PTYs are marked for respawn
      daemonClient.on("connected", () => { syncDaemonSessions().then(adoptOrphanSessions).catch(() => {}); });
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
      cwd: meta.cwd,
      workspacePath: meta.workspacePath ?? migratedSessionPaths[sessionId] ?? null,
      shellId: meta.shellId,
      buffer: [],
      needsRestore: true
    });
    console.log(`🔄 Found saved session: ${sessionId}`);
  }
  if (savedSessions.length > 0) console.log(`✅ Found ${savedSessions.length} saved session(s)`);
  adoptOrphanSessions();
}

export function setupTerminalSocket(io, apiKey) {
  // Forward daemon events to all socket clients
  if (PERSISTENCE_MODE === "daemon") {
    daemonClient.on("output", ({ sessionId, enc, data, replay }) => {
      // Live (non-replay) output = agent still producing → keep working status alive.
      if (replay !== true) touchWorking(sessionId);
      // Live advances the seq; replay (rejoin tail) snapshots the current seq so
      // the client can resync after a reset+replay without a false gap.
      const seq = replay === true ? currentSeq(sessionId) : nextSeq(sessionId);
      if (replay !== true) cacheChunk(sessionId, seq, data, enc); // plan G: recover gaps without a flash
      broadcast(io, "output", { sessionId, enc, data, replay: replay === true, seq });
    });

    // Clear stuck "working" entries (agent crashed / Stop hook never fired).
    startReaper((sessionId) => broadcast(io, "statusState", getStatuses()));

    daemonClient.on("cwdChange", ({ sessionId, cwd }) => {
      const session = sessions.get(sessionId);
      if (session && cwd && session.cwd !== cwd) { session.cwd = cwd; saveSessionMetadata(sessions); }
      broadcast(io, "cwdChange", { sessionId, cwd });
    });
    daemonClient.on("sessionClosed", (sessionId) => {
      sessions.delete(sessionId);
      clearSeqSession(sessionId); // drop seq counter + gap ring
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
    updateAvailable: getUpdateInfo(),
    canSelfUpdate: true, // this build ships the web-triggered self-update flow
    // Capability flags — web feature-detects against these so old agents don't break
    // when web starts sending a new payload shape (e.g. joinSession with cols/rows).
    caps: { joinSessionSize: true },
    ...getCodespaceInfo()
  });

  const emitServerInfo = () => {
    const info = buildServerInfo();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data?.approved) socket.emit("serverInfo", info);
    }
  };

  // Broadcast fresh serverInfo when remote readiness changes
  setRemoteReadyChangeHandler(emitServerInfo);

  // Expose builder + broadcaster so connection handler + update checker can emit
  setupTerminalSocket._buildServerInfo = buildServerInfo;
  setupTerminalSocket._emitServerInfo = emitServerInfo;
}

// Broadcast serverInfo to all approved clients (e.g. when an update is detected).
export function broadcastServerInfo() {
  setupTerminalSocket._emitServerInfo?.();
}

// Registered by index.js — invoked on each web connect to re-check for updates (debounced there)
let onConnectCheck = null;
export function setConnectCheckHandler(fn) { onConnectCheck = fn; }

// Per-socket terminal + remote handlers (called from the single connection handler,
// AFTER the transport bus is ready so remote tiles never race pm.init()).
export async function setupTerminalHandlers(socket, io, apiKey) {
  trackConnection();

  onConnectCheck?.();
  socket.emit("serverInfo", setupTerminalSocket._buildServerInfo?.());

  setupSessionHandlers(socket, io, sessions, workspaces, sessionWorkspaces, sessionOrder);

  setupInputHandlers(socket, sessions);
  setupPushHandlers(socket, io);

  // Remote desktop handlers on same socket if capable (permissions checked at invoke time)
  if (isRemoteAvailable()) {
    await setupRemoteHandlers(socket, apiKey).catch((err) => {
      console.error("❌ Failed to setup remote handlers:", err.message);
    });
  }

  socket.on("disconnect", () => {
    markSubscriptionDisconnected(socket.id);
    trackDisconnection();
  });
}
