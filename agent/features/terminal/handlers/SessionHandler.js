import pty from "node-pty";
import * as daemonClient from "../ptyDaemonClient.js";
import { getDefaultShell, getDefaultCwd, buildShellEnv, saveSessionBuffer, loadSessionBuffer, deleteSessionBuffer, saveSessionMetadata, saveWorkspaces, loadSessionNote, saveSessionNote, deleteSessionNote, UPLOAD_DIR } from "../ptyHelper.js";
import { resolveShell, getShellList, SESSION_NAME_MAX, AUTO_NAME_RE, OUTPUT_SLICE_BYTES } from "../constants.js";
import { createLogger } from "../../../lib/logger.js";

const capsLogger = createLogger("terminal");
import { detectAgentClis } from "../agentCatalog.js";
import { listAgentSessions, matchLiveSessions, conversationTitle, deleteAgentSession } from "../agentHistory.js";
import { getLiveConversations, forgetSession, claimResumedConversation, getConversation, getSessionAgent, setSessionAgent } from "../statusManager.js";
import { setSessionMode } from "../sessionMode.js";
import { engineFromAgent } from "../conversationModes.js";
import { isCodespaces } from "../codespaceManager.js";
import { broadcast } from "../../../transport/broadcast.js";
import { isSensitivePath } from "../../fileExplorer/pathGuard.js";
import { currentSeq, getGap, clearSession } from "../seqStore.js";
import { globalAiManager } from "../../ai/aiManager.js";
import { aiHistoryChunk } from "../../ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../../ai/constants.js";
import fs from "fs";
import path from "path";

const MAX_BUFFER = 2 * 1024 * 1024;
const JOIN_REPLAY_SIZE = 256 * 1024; // 256KB tail on join — keep join latency low
const PERSISTENCE_MODE = "daemon";
const RESPAWN_DEFAULT_COLS = 80;
const RESPAWN_DEFAULT_ROWS = 24;
const RESPAWN_MIN_COLS = 10;
const RESPAWN_MIN_ROWS = 2;

// Resolve cols/rows for a respawned PTY from the client's last known size.
// Falls back to 80×24 when missing or below a sane floor (a transient tiny size
// tracked before disconnect must not persist into the new PTY).
export function pickRespawnSize(session) {
  const cols = session?.lastCols;
  const rows = session?.lastRows;
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= RESPAWN_MIN_COLS && rows >= RESPAWN_MIN_ROWS) {
    return { cols, rows };
  }
  return { cols: RESPAWN_DEFAULT_COLS, rows: RESPAWN_DEFAULT_ROWS };
}

// A terminal keeps its generated name only until its conversation has a title.
// Sessions predating the flag are judged by their name: still in the generated
// shape means it was never the user's.
function isAutoNamed(session) {
  if (session?.autoNamed === true) return true;
  if (session?.autoNamed === false) return false;
  return AUTO_NAME_RE.test(session?.name || "");
}

function fitName(title) {
  const text = String(title || "").trim();
  if (!text) return "";
  return text.length > SESSION_NAME_MAX ? `${text.slice(0, SESSION_NAME_MAX - 1)}\u2026` : text;
}

// One terminal's turn at being named. Returns true when the name changed.
async function nameOneSession(io, sessions, sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !isAutoNamed(session)) return false;
  const conv = getConversation(sessionId);
  const cwd = session.cwd || session.workspacePath;
  if (!conv || !cwd) return false;
  // Reads the same cache the sidebar fills. A conversation missing from it is
  // one whose transcript was written after the last scan — the usual case right
  // after a turn ends — so that miss, and only that miss, pays for a rescan.
  await listAgentSessions({ cwd });
  // The engine, not the surface: a chat UI session records "claude-ui", which is no
  // store's id — the transcript source is keyed by engine.
  const engine = engineFromAgent(conv.agent) || conv.agent;
  // The CLI's OWN name for this conversation, when it stated one — codex's
  // `thread/name/updated`, kept on the live session. It outranks the transcript scan
  // below, which can only ever read the rollout file's first prompt: a thread renamed
  // with `/rename` (or in the TUI) would otherwise keep its opening words forever.
  const named = globalAiManager.getSession(sessionId)?.threadTitle;
  let title = named || conversationTitle(engine, conv.id, cwd);
  if (!title) {
    await listAgentSessions({ cwd, fresh: true });
    title = conversationTitle(engine, conv.id, cwd);
  }
  const name = fitName(title);
  if (!name || name === session.name) return false;
  session.name = name;
  session.autoNamed = true;
  broadcast(io, "session-renamed", { sessionId, name });
  return true;
}

/**
 * Name auto-named terminals after the conversation each is running. Follows the
 * title for as long as the name stays ours: a chat renamed in its own CLI
 * renames the tab too, while a terminal the user named is left alone.
 * With no `sessionId`, every terminal is considered.
 */
export async function syncAutoNames(io, sessions, sessionId = null) {
  const ids = sessionId ? [sessionId] : [...sessions.keys()];
  let changed = false;
  for (const id of ids) {
    if (await nameOneSession(io, sessions, id)) changed = true;
  }
  if (changed) saveSessionMetadata(sessions);
}

// Walk chunks from the end — avoid joining full ≤2MB buffer just to keep a tail
function takeBufferTail(chunks, maxLen) {
  if (!chunks?.length || maxLen <= 0) return "";
  let remaining = maxLen;
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    } else {
      parts.push(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }
  parts.reverse();
  let tail = parts.join("");
  // The byte cut can land mid-ANSI-sequence — the head then starts with a fragment (e.g.
  // ";36;138;61m" missing "\x1b[38;2") which xterm mis-parses. Skip to the next ESC so the replay
  // starts on a clean boundary. Bounded so we never discard a large prefix.
  if (tail.length > 1 && tail.charCodeAt(0) !== 0x1b) {
    const limit = Math.min(tail.length, 512);
    for (let i = 1; i < limit; i++) {
      if (tail.charCodeAt(i) === 0x1b) { tail = tail.slice(i); break; }
    }
  }
  return tail;
}

/**
 * Setup PTY data listeners — shared between createSession and joinSession (buffer mode).
 */
function attachPtyListeners(ptyProcess, sessionId, sessionData, io, sessions) {
  let saveTimeout = null;

  ptyProcess.onData((data) => {
    sessionData.buffer.push(data);
    // Trim by char length keeping the tail — avoids cutting whole chunks mid-ANSI
    const size = sessionData.buffer.reduce((s, c) => s + c.length, 0);
    if (size > MAX_BUFFER) sessionData.buffer = [takeBufferTail(sessionData.buffer, MAX_BUFFER)];
    broadcast(io, "output", { sessionId, data: Buffer.from(data, "utf-8") });
    if (PERSISTENCE_MODE === "buffer") {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveSessionBuffer(sessionId, sessionData.buffer, PERSISTENCE_MODE), 2000);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
    if (PERSISTENCE_MODE === "buffer" && sessionData.buffer.length > 0) {
      saveSessionBuffer(sessionId, sessionData.buffer, PERSISTENCE_MODE);
    }
    sessions.delete(sessionId);
    deleteSessionBuffer(sessionId);
    clearSession(sessionId); // drop seq counter + gap ring
    forgetSession(sessionId);
    broadcast(io, "sessionClosed", sessionId);
  });
}

// sessions ref is passed in from terminalSocket to keep single source of truth.
// workspaces (Map) + sessionWorkspaces (object) are agent-managed and persisted to JSON.
export function setupSessionHandlers(socket, io, sessions, workspaces, sessionWorkspaces, sessionOrder = []) {
  // Persist current workspaces + session->workspace map + session order
  const persist = () => saveWorkspaces(workspaces, sessionWorkspaces, sessionOrder);

  // Both names are broadcast during the transition so a client on the previous version
  // still refreshes. Drop "groupsChanged" once agent 2.6 is the floor.
  const broadcastChanged = () => {
    broadcast(io, "workspacesChanged");
    broadcast(io, "groupsChanged");
  };

  // Tear a terminal down on both persistence paths, so a caller can own the
  // broadcast: a replacement closes the old terminal and announces both changes
  // in one breath.
  const destroySession = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    globalAiManager.destroySession(sessionId);
    if (session.daemon && daemonClient.isConnected()) {
      try {
        await daemonClient.deleteSession(sessionId);
      } catch (e) {
        return false;
      }
    } else if (session.pty) {
      session.pty.kill();
      deleteSessionBuffer(sessionId);
    }
    sessions.delete(sessionId);
    clearSession(sessionId); // drop seq counter + gap ring
    forgetSession(sessionId);
    if (sessionWorkspaces[sessionId]) { delete sessionWorkspaces[sessionId]; persist(); }
    deleteSessionNote(sessionId);
    saveSessionMetadata(sessions);
    return true;
  };

  socket.on("getSessions", async (callback) => {
    capsLogger.info("[diag] getSessions arrived (socket ready to answer)"); // TEMP DIAGNOSTIC — stuck-loading bug
    try {
      const list = [];
      // Fetch live cwd for daemon sessions (OSC 7 updates daemon-side, not agent cache)
      const useDaemon = PERSISTENCE_MODE === "daemon" && daemonClient.isConnected();
      for (const [id, session] of sessions) {
        let cwd = session.cwd;
        if (useDaemon && session.daemon) {
          const liveCwd = await daemonClient.getSessionCwd(id);
          if (liveCwd) { cwd = liveCwd; if (session.cwd !== liveCwd) session.cwd = liveCwd; }
        }
        const workspaceId = sessionWorkspaces[id] || null;
        list.push({
          id, name: session.name, createdAt: session.createdAt, restored: session.restored || false,
          shellId: session.shellId, shellLabel: session.shellLabel, cwd,
          workspaceId,
          // workspacePath is fixed at creation: a `cd` must not move a terminal to another
          // workspace. cwd above is the live one, for display only.
          workspacePath: session.workspacePath || workspaces.get(workspaceId)?.path || null,
          groupId: workspaceId, // legacy field, drop at 2.6
          agent: session.agent || getSessionAgent(id) || null
        });
      }
      // Sort by persisted order; unranked ids (new sessions) fall to the end, stable
      const rank = new Map(sessionOrder.map((id, i) => [id, i]));
      list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
      callback(list); capsLogger.info(`[diag] getSessions ack → ${list.length} sessions`);
    } catch (error) {
      console.error("Failed to list sessions:", error);
      callback([]);
    }
  });

  socket.on("getShells", (callback) => {
    callback({ platform: process.platform, shells: getShellList() });
  });

  // Workspace operations — handled at agent (independent of daemon)
  const listWorkspaces = (callback) => {
    capsLogger.info(`[diag] getWorkspaces arrived+ack → ${workspaces.size} workspaces`); // TEMP DIAGNOSTIC
    callback(Array.from(workspaces.values()));
  };

  const createWorkspace = ({ name, path: wsPath }, callback) => {
    // Validate at this trust boundary: a workspace may be path-less (legacy group), but a
    // supplied path must point at a real directory.
    let resolvedPath = null;
    if (wsPath) {
      if (isSensitivePath(wsPath)) return callback({ success: false, error: "Access denied" });
      try {
        if (!fs.existsSync(wsPath) || !fs.statSync(wsPath).isDirectory()) {
          return callback({ success: false, error: "Path is not a directory" });
        }
        resolvedPath = path.resolve(wsPath);
      } catch (error) {
        return callback({ success: false, error: error.message });
      }
    }
    const existing = resolvedPath && [...workspaces.values()].find((w) => w.path === resolvedPath);
    if (existing) return callback({ success: true, workspace: existing, group: existing });

    const id = `ws-${Date.now()}`;
    const workspace = {
      id,
      name: name || (resolvedPath ? path.basename(resolvedPath) : "Workspace"),
      path: resolvedPath,
      createdAt: Date.now()
    };
    workspaces.set(id, workspace);
    persist();
    broadcastChanged();
    callback({ success: true, workspace, group: workspace });
  };

  const renameWorkspace = ({ workspaceId, groupId, name }, callback) => {
    const workspace = workspaces.get(workspaceId || groupId);
    if (!workspace) return callback({ success: false, error: "Workspace not found" });
    workspace.name = name;
    persist();
    broadcastChanged();
    callback({ success: true });
  };

  const deleteWorkspace = async ({ workspaceId, groupId }, callback) => {
    const id = workspaceId || groupId;
    if (!workspaces.delete(id)) return callback({ success: false, error: "Workspace not found" });
    try {
      // Close all terminals belonging to this workspace
      const targetIds = Object.keys(sessionWorkspaces).filter((sid) => sessionWorkspaces[sid] === id);
      for (const sid of targetIds) {
        const session = sessions.get(sid);
        // Its AI process and snapshot go with the terminal, on both branches —
        // otherwise the claude child keeps running with no terminal behind it.
        globalAiManager.destroySession(sid);
        if (session) {
          if (session.daemon && daemonClient.isConnected()) {
            try { await daemonClient.deleteSession(sid); } catch {}
          } else if (session.pty) {
            session.pty.kill();
            deleteSessionBuffer(sid);
          }
          sessions.delete(sid);
          clearSession(sid); // drop seq counter + gap ring
          forgetSession(sid);
          broadcast(io, "sessionClosed", sid);
        }
        delete sessionWorkspaces[sid];
      }
      persist();
      broadcastChanged();
      callback({ success: true });
    } catch (error) {
      console.error("Failed to delete workspace:", error);
      callback({ success: false, error: error.message });
    }
  };

  const moveSession = ({ sessionId, workspaceId, groupId }, callback) => {
    const id = workspaceId ?? groupId;
    if (id && workspaces.has(id)) {
      sessionWorkspaces[sessionId] = id;
      const session = sessions.get(sessionId);
      if (session) session.workspacePath = workspaces.get(id).path || null;
    } else {
      delete sessionWorkspaces[sessionId];
    }
    persist();
    broadcastChanged();
    callback({ success: true });
  };

  // Repos the user marked as reference-only. Stored per workspace on the agent, so the
  // choice follows the machine rather than one browser.
  const setHiddenRepos = ({ workspaceId, paths }, callback) => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return callback?.({ success: false, error: "Workspace not found" });
    workspace.hiddenRepos = Array.isArray(paths) ? [...new Set(paths.filter((p) => typeof p === "string"))] : [];
    persist();
    broadcastChanged();
    callback?.({ success: true, hiddenRepos: workspace.hiddenRepos });
  };

  socket.on("setWorkspaceHiddenRepos", setHiddenRepos);
  socket.on("getWorkspaces", listWorkspaces);
  socket.on("createWorkspace", createWorkspace);
  socket.on("renameWorkspace", renameWorkspace);
  socket.on("deleteWorkspace", deleteWorkspace);
  socket.on("moveSession", moveSession);

  // Legacy group aliases — a client on the previous version still works. Drop at 2.6.
  socket.on("getGroups", listWorkspaces);
  socket.on("createGroup", createWorkspace);
  socket.on("renameGroup", renameWorkspace);
  socket.on("deleteGroup", deleteWorkspace);

  // Reorder sessions within a workspace. orderedIds = desired order of that workspace's sessions.
  socket.on("reorderSession", ({ orderedIds }, callback) => {
    if (!Array.isArray(orderedIds)) return callback?.({ success: false, error: "orderedIds required" });
    const moving = new Set(orderedIds);
    // Rebuild global order: keep others in place, splice the workspace's ids into their first slot
    const rest = sessionOrder.filter((id) => !moving.has(id));
    const others = [...sessions.keys()].filter((id) => !moving.has(id) && !rest.includes(id));
    sessionOrder.length = 0;
    sessionOrder.push(...rest, ...others, ...orderedIds);
    persist();
    broadcastChanged();
    callback?.({ success: true });
  });

  // TUI agent CLIs detected on PATH (cached) — powers the new-terminal modal
  socket.on("getAgentClis", (_payload, callback) => {
    if (typeof _payload === "function") callback = _payload; // bare-emit legacy shape
    callback?.({ success: true, agents: detectAgentClis() });
  });

  // Past conversations each agent CLI kept for one directory — the sidebar lists
  // them under the terminal standing there so one can be resumed in place.
  socket.on("getAgentSessions", async ({ cwd, limit } = {}, callback) => {
    // Terminal start time and cwd ride along so the matcher can weigh the
    // transcript clock — the conversation a terminal opened is the one that
    // began writing after it started.
    const live = getLiveConversations().map((l) => {
      const session = sessions.get(l.sessionId);
      return { ...l, startedAt: session?.createdAt || null, cwd: session?.cwd || session?.workspacePath || null };
    });
    const rows = await listAgentSessions({ cwd, limit });
    callback?.({ success: true, sessions: matchLiveSessions(rows, live) });
    // The rows just landed in cache — name whatever terminal they belong to.
    syncAutoNames(io, sessions);
  });

  // A terminal opened to resume a history row already knows which conversation
  // it is running — say so now rather than wait for the CLI's first hook, which
  // only fires once the user sends a message.
  socket.on("claimAgentSession", ({ sessionId, agent, conversationId } = {}, callback) => {
    claimResumedConversation(sessionId, { agent, sessionId: conversationId });
    // Its title exists already — this chat has been talked to before, so the
    // terminal can carry its name from the moment it opens.
    syncAutoNames(io, sessions, sessionId);
    callback?.({ success: true });
  });

  // Move a terminal between the agent CLI in it and the chat UI, on the exact
  // conversation it is already running.
  socket.on("setSessionMode", async ({ sessionId, mode } = {}, callback) => {
    try {
      const res = await setSessionMode(sessionId, mode, { sessions, io });
      if (res.success) saveSessionMetadata(sessions);
      callback?.(res);
    } catch (err) {
      capsLogger.error(`setSessionMode failed: ${err.message}`);
      callback?.({ success: false, error: err.message });
    }
  });

  socket.on("deleteAgentSession", async ({ agent, sessionId, cwd } = {}, callback) => {
    try {
      const ok = await deleteAgentSession({ agent, sessionId, cwd });
      callback?.({ success: ok });
    } catch (err) {
      callback?.({ success: false, error: err?.message });
    }
  });

  socket.on("createSession", async ({ name, shellId, workspaceId, groupId, cwd, nameIsAuto, agent, replaces }, callback) => {
    const sessionId = `session-${Date.now()}`;
    const wsId = workspaceId ?? groupId;
    const workspace = wsId ? workspaces.get(wsId) : null;
    const agentId = typeof agent === "string" ? agent : agent?.id || null;

    try {
      const shellConfig = resolveShell(shellId);
      const shellEnv = buildShellEnv();
      shellEnv.NINE_REMOTE_SESSION_ID = sessionId;
      // cwd comes from the client (a folder picked in the tree, or the last session's cwd);
      // validate at this trust boundary — fall back to the workspace root, then the default.
      let resolvedCwd = getDefaultCwd(isCodespaces());
      // A malformed cwd (NUL byte, non-string) makes existsSync throw
      const usable = (dir) => {
        try { return dir && !isSensitivePath(dir) && fs.existsSync(dir); } catch { return false; }
      };
      if (usable(workspace?.path)) resolvedCwd = workspace.path;
      if (usable(cwd)) resolvedCwd = cwd;
      // Fixed at creation — a later `cd` must not move this terminal to another workspace.
      const workspacePath = workspace?.path || null;

      // Auto-name "Term N" if user didn't provide a custom name (cross-platform).
      // An auto-named terminal follows its agent conversation's title; one the
      // user typed a name for is theirs and is never renamed for them. The UI
      // fills the box in for an unnamed agent tab and says so — that name is a
      // placeholder, not the user having named anything.
      const autoNamed = !name || nameIsAuto === true;
      const autoName = name || `Term ${sessions.size + 1}`;

      // A replacement is one transaction: the new terminal exists before the old one
      // is announced as gone, so no client ever sees a list (or a pane row) without it.
      // The retired id travels on the ack so the caller can hand its slot over.
      const retire = async (result) => {
        const retired = replaces && replaces !== result.sessionId && await destroySession(replaces);
        broadcast(io, "sessionsChanged");
        callback({ ...result, replaced: retired ? replaces : null });
        if (retired) broadcast(io, "sessionClosed", replaces);
      };

      // Daemon mode
      if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
        const result = await daemonClient.createSession(autoName, 80, 24, shellId, sessionId, resolvedCwd);
        if (result.success) {
          if (agentId) setSessionAgent(result.sessionId, agentId);
          sessions.set(result.sessionId, { daemon: true, name: autoName, autoNamed, createdAt: Date.now(), cwd: result.cwd, workspacePath, shellId: result.shellId, shellLabel: result.shellLabel, agent: agentId });
          if (workspace) { sessionWorkspaces[result.sessionId] = workspace.id; persist(); }
          saveSessionMetadata(sessions);
          // Other devices hold this list in memory — tell them a terminal appeared.
          await retire({ success: true, sessionId: result.sessionId, shellLabel: result.shellLabel });
        } else {
          callback({ success: false, error: result.error });
        }
        return;
      }

      // Buffer mode PTY
      const ptyProcess = pty.spawn(shellConfig.path, shellConfig.args, { name: "xterm-256color", cols: 80, rows: 24, cwd: resolvedCwd, env: shellEnv, useConpty: false });
      if (agentId) setSessionAgent(sessionId, agentId);
      const sessionData = { pty: ptyProcess, name: autoName, autoNamed, createdAt: Date.now(), buffer: [], cwd: resolvedCwd, workspacePath, shellId: shellConfig.id, shellLabel: shellConfig.label, agent: agentId };

      attachPtyListeners(ptyProcess, sessionId, sessionData, io, sessions);
      sessions.set(sessionId, sessionData);
      if (workspace) { sessionWorkspaces[sessionId] = workspace.id; persist(); }
      await retire({ success: true, sessionId, shellLabel: shellConfig.label });
    } catch (error) {
      console.error("Failed to create session:", error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on("joinSession", async (payload, callback) => {
    // Accept both {sessionId, cols, rows} (new) and bare sessionId (legacy) for the
    // transition. cols/rows are the client's real measured size — used to spawn a
    // respawned PTY at the right size instead of guessing 80×24.
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    const joinCols = typeof payload === "object" ? payload?.cols : undefined;
    const joinRows = typeof payload === "object" ? payload?.rows : undefined;
    let session = sessions.get(sessionId);

    // Session gone (daemon killed / restarted, metadata lost) → recreate a fresh PTY in the same tab
    if (!session && PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
      try {
        const autoName = `Term ${sessions.size + 1}`;
        const cwd = getDefaultCwd(isCodespaces());
        const { cols, rows } = pickRespawnSize({ lastCols: joinCols, lastRows: joinRows });
        const created = await daemonClient.createSession(autoName, cols, rows, undefined, sessionId, cwd);
        if (!created.success) return callback({ success: false, error: created.error });
        session = { daemon: true, name: autoName, createdAt: Date.now(), cwd: created.cwd, shellId: created.shellId, shellLabel: created.shellLabel, lastCols: cols, lastRows: rows };
        sessions.set(sessionId, session);
        saveSessionMetadata(sessions);
        const result = await daemonClient.joinSession(sessionId);
        return callback({ success: result.success, name: session.name, cwd: result.cwd || session.cwd, recreated: true, error: result.error });
      } catch (e) {
        return callback({ success: false, error: e.message });
      }
    }

    if (!session) return callback({ success: false, error: "Session not found" });

    // Daemon mode
    if (session.daemon && daemonClient.isConnected()) {
      try {
        // Session lost after daemon respawn → recreate PTY with same id + title + prior cwd (buffer gone, metadata kept)
        if (session.needsRespawn) {
          // Prefer the live size from this join payload; fall back to the last tracked size.
          const { cols, rows } = pickRespawnSize({ lastCols: joinCols ?? session.lastCols, lastRows: joinRows ?? session.lastRows });
          const created = await daemonClient.createSession(session.name, cols, rows, session.shellId, sessionId, session.cwd);
          if (!created.success) return callback({ success: false, error: created.error });
          delete session.needsRespawn;
          session.cwd = created.cwd;
          session.shellLabel = created.shellLabel;
          session.lastCols = cols;
          session.lastRows = rows;
          saveSessionMetadata(sessions);
        }
        const result = await daemonClient.joinSession(sessionId);
        // Persist live cwd (user may have cd'd) — agent is source of truth
        if (result.cwd && result.cwd !== session.cwd) { session.cwd = result.cwd; saveSessionMetadata(sessions); }
        callback({ success: result.success, name: session.name, cwd: result.cwd || session.cwd, total: result.total || 0, replaySize: result.replaySize || 0, error: result.error });
      } catch (e) {
        callback({ success: false, error: e.message });
      }
      return;
    }

    // Buffer mode: restore PTY if needed
    if (session.needsRestore && PERSISTENCE_MODE === "buffer") {
      try {
        const shell = getDefaultShell();
        const shellArgs = process.platform === "win32" ? [] : ["-l"];
        const cwd = getDefaultCwd(isCodespaces());
        const ptyProcess = pty.spawn(shell, shellArgs, { name: "xterm-256color", cols: 80, rows: 24, cwd, env: buildShellEnv(), useConpty: false });

        session.pty = ptyProcess;
        session.needsRestore = false;
        session.cwd = cwd;

        const saved = loadSessionBuffer(sessionId, PERSISTENCE_MODE);
        if (saved) session.buffer = [saved];

        attachPtyListeners(ptyProcess, sessionId, session, io, sessions);
        console.log(`✅ Restored PTY session: ${sessionId}`);
      } catch (error) {
        console.error("Failed to restore session:", error);
        return callback({ success: false, error: "Failed to restore session" });
      }
    }

    if (session.buffer?.length > 0) {
      // enc:"bin" routes it through the send door's capability check like every
      // other output — a legacy peer gets b64 there instead of a raw Buffer.
      socket.emit("output", { sessionId, enc: "bin", data: Buffer.from(takeBufferTail(session.buffer, JOIN_REPLAY_SIZE), "utf-8") });
    }
    // Return the current live seq so the client can resync lastSeq after the
    // reset+replay (next live chunk = currentSeq + 1 → contiguous, no false gap).
    callback({ success: true, name: session.name, cwd: session.cwd, seq: currentSeq(sessionId) });
  });

  // Client capability announcement — e.g. fragOut: understands fragmented prefix
  // events (part/parts markers). Fires once per connect on whichever carrier is up.
  // Answered symmetrically: the client re-announces on every carrier connect, and
  // its record of OUR capabilities lives on a PM that a reconnect may have replaced.
  socket.on("caps", (caps = {}) => {
    capsLogger.debug(`[caps] client announced: ${JSON.stringify(caps)}`);
    if (caps?.fragOut) socket.data.fragOut = true;
    if (caps?.fragCtl) socket.data.fragCtl = true;
    socket.emit("srvCaps", { env2: 1, fragCtl: 1 });
  });

  // Scroll-up history fetch — client asks for the prefix older than the bytes it holds.
  // Emit prefix ONLY to the requesting socket (not broadcast) so other clients keep their stream intact.
  socket.on("requestHistory", async ({ sessionId, have } = {}, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback?.({ success: false, error: "Session not found" });
    if (!session.daemon || !daemonClient.isConnected()) return callback?.({ success: false, error: "History unavailable" });
    try {
      const result = await daemonClient.requestHistory(sessionId, have || 0);
      if (!result.success) return callback?.({ success: false, error: result.error });
      if (result.prefix) {
        // Fragment SCTP-safe with part markers — but only for clients that reassemble.
        // An old client would splice+replay per event, so it keeps the single big
        // event. Bytes are Buffers (canonical internal form); the send door
        // downgrades to b64 for a peer that never announced caps.binOut.
        if (socket.data?.fragOut) {
          const raw = Buffer.from(result.prefix, "base64");
          const parts = Math.max(1, Math.ceil(raw.length / OUTPUT_SLICE_BYTES));
          for (let part = 0; part < parts; part++) {
            const piece = raw.subarray(part * OUTPUT_SLICE_BYTES, (part + 1) * OUTPUT_SLICE_BYTES);
            socket.emit("output", { sessionId, enc: "bin", isHistoryPrefix: true, part, parts, data: piece });
          }
        } else {
          socket.emit("output", { sessionId, enc: "b64", isHistoryPrefix: true, data: result.prefix });
        }
      }
      callback?.({ success: true, prefixLen: result.prefixLen || 0, total: result.total || 0, remaining: result.remaining || 0 });
    } catch (e) {
      callback?.({ success: false, error: e.message });
    }
  });

  // Scroll-up history fetch for the chat pane: the events older than the oldest seq
  // the client holds. Same one-socket-only contract as requestHistory above.
  socket.on("aiHistory", ({ sessionId, before } = {}, callback) => {
    try {
      // The agent owns the chat log (the daemon only holds the CLI process), so the
      // older window is a slice of it — same one-socket-only contract as above.
      const session = globalAiManager.getSession(sessionId);
      if (!session) return callback?.({ success: false, error: "Session not found" });
      const { events, hasMore } = aiHistoryChunk(session.history, before || 0, AI_REPLAY_BYTES);
      callback?.({ success: true, events, hasMore });
    } catch (e) {
      callback?.({ success: false, error: e.message });
    }
  });

  // Seq peek: the client asks "what is the newest live seq?" when it becomes
  // visible again. Gap detection otherwise only runs when a NEW chunk arrives, so
  // output produced while the app was backgrounded would stay missing until the
  // terminal happened to print something else.
  socket.on("peekSeq", ({ sessionId } = {}, callback) => {
    callback?.({ seq: currentSeq(sessionId) });
  });

  // Gap recovery (plan G): client lost a small range of live chunks during a
  // background suspension. Emit only the missing range (flagged gap:true so the
  // client appends without reset/mirror) instead of a full reset+tail replay.
  // Miss (gap spans an evicted chunk) → callback hit:false so the client falls
  // back to reset+rejoin.
  socket.on("requestGap", ({ sessionId, fromSeq, toSeq } = {}, callback) => {
    if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq)) return callback?.({ hit: false });
    const chunks = getGap(sessionId, fromSeq, toSeq);
    if (!chunks) return callback?.({ hit: false });
    for (const c of chunks) {
      socket.emit("output", { sessionId, seq: c.seq, enc: c.enc, data: c.data, gap: true });
    }
    callback?.({ hit: true, count: chunks.length });
  });

  socket.on("deleteSession", async (sessionId, callback) => {
    if (!sessions.has(sessionId)) return callback({ success: false, error: "Session not found" });
    // The AI process and its snapshot go with the terminal: destroySession stops the
    // chat CLI first, so nothing is left running with no terminal behind it.
    const ok = await destroySession(sessionId);
    if (!ok) return callback({ success: false, error: "Could not close session" });
    broadcast(io, "sessionClosed", sessionId);
    callback({ success: true });
  });

  socket.on("renameSession", async ({ sessionId, name }, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback({ success: false, error: "Session not found" });

    try {
      // Name is agent-owned (single source of truth) for both daemon and buffer mode
      session.name = name;
      // The user named this terminal: its conversation's title stops driving it.
      session.autoNamed = false;
      broadcast(io, "session-renamed", { sessionId, name });
      saveSessionMetadata(sessions);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Per-session note (free-form text, persisted server-side, survives restarts)
  socket.on("getNote", ({ sessionId } = {}, callback) => {
    if (typeof callback !== "function") return;
    callback({ success: true, text: loadSessionNote(sessionId) });
  });

  socket.on("saveNote", ({ sessionId, text } = {}, callback) => {
    if (typeof callback !== "function") return;
    const ok = saveSessionNote(sessionId, text);
    callback({ success: ok });
  });
}
