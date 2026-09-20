// Terminal Socket.IO namespace
import chalk from "chalk";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import * as daemonClient from "./ptyDaemonClient.js";

import { isRemoteAvailable, setupRemoteHandlers } from "../remote/remoteSocket.js";
import { isMobileAvailable, setupMobileHandlers } from "../mobile/mobileSocket.js";
import { isRemoteReady, setRemoteReadyChangeHandler, getUpdateInfo } from "../../api/ui.js";
import { isCodespaces, getCodespaceInfo, trackConnection, trackDisconnection } from "./codespaceManager.js";
import { listSavedBufferSessions, loadSessionMetadata, loadGroups, loadWorkspaces, saveWorkspaces, saveSessionMetadata, saveSessionMetadataRaw } from "./ptyHelper.js";
import { migrateGroupsToWorkspaces, assignOrphanSessions } from "./workspaceMigration.js";
import { setupSessionHandlers, syncAutoNames } from "./handlers/SessionHandler.js";
import { setupInputHandlers } from "./handlers/InputHandler.js";
import { setupPushHandlers } from "./handlers/PushHandler.js";
import { reconcileClaudeEnv, autoEnableInstalledHooks, reconcileCodexTrust } from "./hookManager.js";
import { isMcpEnabled, syncMcpConfig, MCP_CLIENTS } from "../../mcp/mcpConfig.js";
import { readSettings } from "../../lib/settings.js";
import { markSubscriptionDisconnected } from "./pushManager.js";
import { clearNotification } from "./notificationManager.js";
import { touchWorking, touchOutput, startReaper, getStatuses, getStatus, getConversation, setSessionAgent, getSessionAgent, clearSessionAgent, clearStatus, forgetSession, onAgentChange, restoreConversation, setConversationPersister, onAutoNameRequest, onProcessChange, confirmShellClear, isPendingShellClear, applyEvent, scheduleDoneCommit } from "./statusManager.js";
import { agentIdFromTitle } from "./agentCatalog.js";
import { broadcast } from "../../transport/broadcast.js";
import { nextSeq, currentSeq, cacheChunk, clearSession as clearSeqSession } from "./seqStore.js";
import { AUTO_NAME_DEBOUNCE_MS, OUTPUT_SLICE_BYTES } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const termLogger = createLogger("terminal");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORANGE = chalk.rgb(230, 138, 110);
const PERSISTENCE_MODE = "daemon";
const PKG_VERSION = typeof __CLI_VERSION__ !== "undefined"
  ? __CLI_VERSION__
  : JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")).version;

// OSC 0/2 title scan on daemon output — many agent CLIs announce themselves in the
// title before any hook fires. Tail buffer joins sequences split across chunks.
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const TITLE_TAIL_MAX = 256;
// How long after a shell reading to look again before believing the TUI exited.
// Long enough that a tool call has handed control back, short enough to be unseen.
const SHELL_CONFIRM_MS = 1500;
const titleTails = new Map(); // sessionId -> unterminated OSC fragment

// Re-read the foreground process and settle a reading onProcessChange held back.
// The read is asynchronous, so a second reading that arrives meanwhile (a tool call
// ending) is left to decide on its own — this only settles what is still pending.
async function settleShellReading(io, sessionId) {
  if (!isPendingShellClear(sessionId)) return;
  const live = await daemonClient.listSessions().catch(() => null);
  const entry = live?.find((s) => s.id === sessionId);
  const result = confirmShellClear(sessionId, entry?.foregroundProcess);
  if (result?.state !== "idle") return;
  broadcast(io, "statusChange", { sessionId, state: "idle", tool: null, conversationId: null });
  broadcast(io, "statusState", getStatuses());
}

function scanTitleForAgent(sessionId, text) {
  const buf = (titleTails.get(sessionId) || "") + text;
  let last = null;
  OSC_TITLE_RE.lastIndex = 0;
  for (let m; (m = OSC_TITLE_RE.exec(buf)); ) last = m[1];
  if (last) {
    const agentId = agentIdFromTitle(last);
    if (agentId) setSessionAgent(sessionId, agentId);
  }
  // Keep only an unterminated trailing OSC; a completed one needs no carry-over
  const cut = buf.lastIndexOf("\x1b]");
  const frag = cut === -1 ? "" : buf.slice(cut);
  if (frag && frag.length <= TITLE_TAIL_MAX && !frag.slice(3).includes("\x07") && !frag.includes("\x1b\\")) {
    titleTails.set(sessionId, frag);
  } else {
    titleTails.delete(sessionId);
  }
}

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
// Serialised: the daemon "connected" event can fire while an initial sync is
// still awaiting listSessions(). Two runs interleaving would have the later
// sessions.clear() wipe the entries the earlier one had just rebuilt.
let syncInFlight = null;

function syncDaemonSessions() {
  // Queue tail swallows the PREVIOUS run's rejection (so one failure doesn't
  // poison the chain), while the promise handed back to this caller keeps its
  // own — awaiting a failed sync must still throw for the caller.
  const mine = (syncInFlight || Promise.resolve())
    .catch(() => {})
    .then(() => _syncDaemonSessions());
  syncInFlight = mine.catch(() => {});
  return mine;
}

async function _syncDaemonSessions() {
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
      // Whose the name is survives the restart too — dropping it made every
      // already-titled terminal look user-named, so it stopped following its chat.
      autoNamed: meta.autoNamed !== false,
      createdAt: meta.createdAt,
      shellId: meta.shellId,
      cwd: live?.cwd || meta.cwd,
      workspacePath: meta.workspacePath ?? migratedSessionPaths[id] ?? null,
      // Restore last client size so a respawned PTY (after agent/daemon restart)
      // inherits the real terminal size instead of falling back to 80×24.
      lastCols: meta.cols ?? null,
      lastRows: meta.rows ?? null,
      needsRespawn: !live,
      agent: meta.agent || null
    });
    if (meta.agent) setSessionAgent(id, meta.agent);
    // The PTY outlived this agent process; the chat running inside it did too,
    // so replay the link rather than let a restart silently unlink them.
    restoreConversation(id, meta);
  }
  saveSessionMetadata(sessions);
}

// Naming reads a transcript, so a burst of events for one terminal must collapse
// into a single pass. Per session: two terminals finishing at once are two
// different transcripts and must not cancel each other.
const autoNameTimers = new Map();
let autoNameIo = null;
function scheduleAutoName(sessionId) {
  if (!autoNameIo || !sessionId || autoNameTimers.has(sessionId)) return;
  autoNameTimers.set(sessionId, setTimeout(() => {
    autoNameTimers.delete(sessionId);
    syncAutoNames(autoNameIo, sessions, sessionId).catch(() => {});
  }, AUTO_NAME_DEBOUNCE_MS));
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

/**
 * Which workspace a path belongs to: the deepest workspace whose root CONTAINS it
 * (or that it contains) — exact string equality misses trailing slashes, a `cd`
 * into a subfolder, and a path the caller only knows approximately. Pure, so the
 * matching rule is testable without touching the persisted maps.
 */
export function matchWorkspacePath(workspaceList, targetPath) {
  const target = targetPath ? resolve(targetPath) : "";
  if (!target) return null;
  let exact = null, contains = null, within = null;
  for (const w of workspaceList || []) {
    if (!w?.path) continue;
    const p = resolve(w.path);
    if (target === p) exact = w;
    // The workspace root contains the target — deepest wins.
    else if (target.startsWith(p + "/") && (!contains || p.length > resolve(contains.path).length)) contains = w;
    // The target contains the workspace — closest (shallowest) wins.
    else if (p.startsWith(target + "/") && (!within || p.length < resolve(within.path).length)) within = w;
  }
  return exact || contains || within || null;
}

/**
 * Register a daemon-spawned PTY into the agent's session map — the step beyond a
 * bare daemon spawn. Without it the PTY runs (the fleet sees it) but no list
 * does: the sidebar, workspace pinning, and persistence all read this map.
 * `workspacePath` (or the cwd, when that is all the caller knows) pins the tab.
 */
export function registerManagedSession({ sessionId, name, autoNamed = true, cwd = null, workspacePath = null, shellId = null, shellLabel = null, agent = null }) {
  const workspace = matchWorkspacePath([...workspaces.values()], workspacePath || cwd) || null;
  sessions.set(sessionId, {
    daemon: true,
    name,
    autoNamed,
    createdAt: Date.now(),
    cwd: cwd || workspace?.path || null,
    workspacePath: workspace?.path || null,
    shellId,
    shellLabel,
    agent
  });
  if (workspace) {
    sessionWorkspaces[sessionId] = workspace.id;
    saveWorkspaces(workspaces, sessionWorkspaces, sessionOrder);
  }
  saveSessionMetadata(sessions);
  // Other devices hold this list in memory — tell them a terminal appeared.
  broadcast(null, "sessionsChanged");
  return { success: true, sessionId, workspacePath: workspace?.path || null };
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

  // A newly learned conversation must reach disk without waiting for the next
  // session create/rename — a restart in between would unlink it from its terminal.
  // It is also when an auto-named terminal can first take its chat's title, so the
  // rename rides the same signal, coalesced: hooks fire far faster than names change.
  setConversationPersister(() => saveSessionMetadata(sessions));

  // A CLI that just finished a turn has written its transcript, so this is when
  // an auto-named terminal can first take its conversation's title.
  onAutoNameRequest(scheduleAutoName);

  // Backfill scrollback env for users who enabled Claude hook before the fix
  try { reconcileClaudeEnv(); } catch {}
  // Auto-enable notify hooks for every installed AI tool (claude/codex/opencode)
  try { autoEnableInstalledHooks(); } catch {}
  // Codex runs no hook it holds no trusted hash for, so the handlers just written would
  // sit there doing nothing. Its app-server computes them (measured ~90ms), and this is
  // fire-and-forget: a chat opened meanwhile is no worse off than before this existed.
  reconcileCodexTrust().catch(() => {});
  // The CLI configs mirror the artifact setting — reconcile them, since a token
  // change or a fresh install leaves them stale (or missing) after a hook run.
  try { syncMcpConfig(); } catch {}

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
      autoNamed: meta.autoNamed !== false,
      createdAt: meta.createdAt || Date.now(),
      cwd: meta.cwd,
      workspacePath: meta.workspacePath ?? migratedSessionPaths[sessionId] ?? null,
      shellId: meta.shellId,
      buffer: [],
      needsRestore: true
    });
    restoreConversation(sessionId, meta);
    console.log(`🔄 Found saved session: ${sessionId}`);
  }
  if (savedSessions.length > 0) console.log(`✅ Found ${savedSessions.length} saved session(s)`);
  adoptOrphanSessions();
}

let slicedChunks = 0; // diagnostic: how many daemon chunks exceeded one SCTP message

export function setupTerminalSocket(io, apiKey) {
  autoNameIo = io;
  // Forward daemon events to all socket clients
  if (PERSISTENCE_MODE === "daemon") {
    daemonClient.on("output", ({ sessionId, enc, data, replay }) => {
      // Live (non-replay) output = agent still producing → keep working status alive,
      // and stamp it for the AI watchdog (a chat turn riding on a busy terminal).
      if (replay !== true) { touchWorking(sessionId); touchOutput(sessionId); }
      // Decoded once at ingest — from here to the wire the canonical form is a
      // Buffer. Peers that never announced caps.binOut are downgraded to b64 at
      // the send door (PM), not here: emit-time does not know who is listening.
      const raw = enc === "b64" ? Buffer.from(data, "base64") : Buffer.from(data || "");
      if (raw.length > OUTPUT_SLICE_BYTES) {
        slicedChunks++;
        if (slicedChunks === 1 || slicedChunks % 500 === 0) {
          termLogger.info(`[slice] chunk ${raw.length >> 10}KB → ${Math.ceil(raw.length / OUTPUT_SLICE_BYTES)} events (total sliced: ${slicedChunks})`);
        }
      }
      // Title-based agent detection (works for replay too — same session, same CLI).
      // Scan the FULL chunk before slicing — a slice boundary could cut an OSC sequence.
      if (enc === "b64") scanTitleForAgent(sessionId, raw.toString("utf8"));
      // Fragment at the source: one event per OUTPUT_SLICE_BYTES so every chunk fits one
      // SCTP message on the RTC control DC. Each slice is a complete event — clients
      // append in order, so no reassembly is needed for live/replay output.
      for (let off = 0; off < raw.length || off === 0; off += OUTPUT_SLICE_BYTES) {
        const piece = raw.subarray(off, off + OUTPUT_SLICE_BYTES);
        // Live advances the seq (per slice, contiguous — gap detection stays exact);
        // replay (rejoin tail) snapshots the current seq so the client can resync
        // after a reset+replay without a false gap.
        const seq = replay === true ? currentSeq(sessionId) : nextSeq(sessionId);
        if (replay !== true) cacheChunk(sessionId, seq, piece); // plan G: recover gaps without a flash
        broadcast(io, "output", { sessionId, enc: "bin", data: piece, replay: replay === true, seq });
      }
    });

    // Clear stuck "working" entries (agent crashed / Stop hook never fired).
    startReaper((sessionId) => broadcast(io, "statusState", getStatuses()));
    // Hookless agent detection (launch line / OSC title) → push new tool to clients
    onAgentChange(() => broadcast(io, "statusState", getStatuses()));

    daemonClient.on("cwdChange", ({ sessionId, cwd }) => {
      const session = sessions.get(sessionId);
      if (session && cwd && session.cwd !== cwd) { session.cwd = cwd; saveSessionMetadata(sessions); }
      broadcast(io, "cwdChange", { sessionId, cwd });
    });
    daemonClient.on("processChange", ({ sessionId, process: procName }) => {
      const result = onProcessChange(sessionId, procName);
      if (result?.state === "pendingShell") {
        // Readings come from terminal output, and a terminal that just went quiet
        // sends no more of them — so the confirmation is a one-shot re-read rather
        // than the next event. A real exit is still a shell a moment later; a tool
        // call has the agent back in front well before that.
        setTimeout(() => settleShellReading(io, sessionId), SHELL_CONFIRM_MS);
        return;
      }
      if (result?.state === "idle") {
        broadcast(io, "statusChange", { sessionId, state: "idle", tool: null, conversationId: null });
        broadcast(io, "statusState", getStatuses());
      }
    });
    daemonClient.on("sessionClosed", (sessionId) => {
      sessions.delete(sessionId);
      clearSeqSession(sessionId); // drop seq counter + gap ring
      forgetSession(sessionId);
      titleTails.delete(sessionId);
      const timer = autoNameTimers.get(sessionId);
      if (timer) { clearTimeout(timer); autoNameTimers.delete(sessionId); }
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
    mobileAvailable: isMobileAvailable(),
    daemonMode: PERSISTENCE_MODE === "daemon" && daemonClient.isConnected(),
    platform: process.platform,
    updateAvailable: getUpdateInfo(),
    canSelfUpdate: true, // this build ships the web-triggered self-update flow
    // Capability flags — web feature-detects against these so old agents don't break
    // when web starts sending a new payload shape (e.g. joinSession with cols/rows).
    caps: { joinSessionSize: true, artifact: true },
    artifactEnabled: isMcpEnabled(),
    voiceConfig: readSettings().voiceConfig || null,
    // Which CLIs the switch writes to — the settings screen names them rather than
    // hardcoding a list that would drift as clients are added.
    mcpClients: MCP_CLIENTS,
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

// Broadcast agent working/blocked/done state transitions for AI UI sessions.
// `data` is the AI event that caused it: an `init` carries the conversation id a chat
// session never gets from a PTY hook, and the tab menu and bell read it to label the row.
export function broadcastAiStatus(sessionId, state, tool, data = null) {
  if (!autoNameIo) return null;

  // A done waits out its debounce window so the stream's next event can cancel
  // the flash; every other state commits now (and cancels it — applyEvent).
  if (state === "done") {
    scheduleDoneCommit(sessionId, () => {
      const conversationId = data?.sessionId || data?.threadId || getConversation(sessionId)?.id || null;
      const before = getStatus(sessionId);
      const entry = applyEvent({ type: state, sessionId, tool });
      if (!entry || entry === before) return;
      broadcast(autoNameIo, "statusChange", { sessionId, state, tool, conversationId });
      broadcast(autoNameIo, "statusState", getStatuses());
    });
    return getStatus(sessionId);
  }

  const conversationId = data?.sessionId || data?.threadId || getConversation(sessionId)?.id || null;
  const before = getStatus(sessionId);
  const entry = applyEvent({ type: state, sessionId, tool });
  // One user action reaches here twice (the prompt handler and the session's own event
  // both say "working"), and a stray `done` on an idle session is refused by applyEvent.
  // Broadcast the map, not the request: a no-op is not a change worth re-rendering for.
  if (!entry || entry === before) return entry;
  broadcast(autoNameIo, "statusChange", { sessionId, state, tool, conversationId });
  broadcast(autoNameIo, "statusState", getStatuses());
  return entry;
}

// Registered by index.js — invoked on each web connect to re-check for updates (debounced there)
let onConnectCheck = null;
export function setConnectCheckHandler(fn) { onConnectCheck = fn; }

// Per-socket terminal + remote handlers (called from the single connection handler,
// AFTER the transport bus is ready so remote tiles never race pm.init()).
export async function setupTerminalHandlers(socket, io, apiKey) {
  termLogger.info(`[diag] setupTerminalHandlers START id=${socket.id} virtual=${!!socket.defersWsAdapter}`); // TEMP DIAGNOSTIC
  trackConnection();

  onConnectCheck?.();
  // What THIS agent understands. The client mirrors it with its own "caps" — both
  // sides need the announcement before either may switch off the legacy wire form.
  socket.emit("srvCaps", { env2: 1 });
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

  // Android mirroring — attached whenever adb is on the host (permissions and
  // device pick happen at invoke time).
  // Unconditional: setup handlers must exist even with no adb on the host —
  // installing the missing tooling from the UI is exactly what they are for.
  setupMobileHandlers(socket);

  socket.on("disconnect", () => {
    markSubscriptionDisconnected(socket.id);
    trackDisconnection();
  });
}
