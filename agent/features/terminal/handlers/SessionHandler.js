import pty from "node-pty";
import * as daemonClient from "../ptyDaemonClient.js";
import { getDefaultShell, getDefaultCwd, buildShellEnv, saveSessionBuffer, loadSessionBuffer, deleteSessionBuffer, saveSessionMetadata, saveWorkspaces, loadSessionNote, saveSessionNote, deleteSessionNote, UPLOAD_DIR } from "../ptyHelper.js";
import { resolveShell, getShellList, SESSION_NAME_MAX, AUTO_NAME_RE, OUTPUT_SLICE_BYTES } from "../constants.js";
import { createLogger } from "../../../lib/logger.js";

const capsLogger = createLogger("terminal");
import { detectAgentClis, agentRenameCommand, agentIdFromProcess } from "../agentCatalog.js";
import { listAgentSessions, matchLiveSessions, conversationTitle, deleteAgentSession } from "../agentHistory.js";
import { getLiveConversations, forgetSession, claimResumedConversation, getConversation, getSessionAgent, setSessionAgent } from "../statusManager.js";
import { setSessionMode, sendTerminalInput, CLEAR_LINE } from "../sessionMode.js";
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

// Export destroyer so non-socket callers tear down sessions through the same code path.
let sessionDestroyer = null;
export async function destroySessionById(sessionId) {
  if (!sessionDestroyer) return false;
  return await sessionDestroyer(sessionId);
}

// Resolve cols/rows for respawned PTY, falling back to 80x24 if missing or below minimum.
export function pickRespawnSize(session) {
  const cols = session?.lastCols;
  const rows = session?.lastRows;
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= RESPAWN_MIN_COLS && rows >= RESPAWN_MIN_ROWS) {
    return { cols, rows };
  }
  return { cols: RESPAWN_DEFAULT_COLS, rows: RESPAWN_DEFAULT_ROWS };
}

// Check if terminal name was auto-generated rather than user-assigned.
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

// Live terminals shaped for matchLiveSessions: conversation/prompt signals plus
// start time and cwd for the correlation fallbacks.
function liveHistoryRows(sessions) {
  return getLiveConversations().map((l) => {
    const session = sessions.get(l.sessionId);
    return { ...l, startedAt: session?.createdAt || null, cwd: session?.cwd || session?.workspacePath || null };
  });
}

async function nameOneSession(io, sessions, sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !isAutoNamed(session)) return false;
  const conv = getConversation(sessionId);
  const agent = conv?.agent || getSessionAgent(sessionId);
  const cwd = session.cwd || session.workspacePath;
  if (!agent || !cwd) return false;
  // Rescan sessions cache only if conversation is missing.
  const rows = await listAgentSessions({ cwd });
  // The engine, not the surface: a chat UI session records "claude-ui", which is no
  // store's id — the transcript source is keyed by engine.
  const engine = engineFromAgent(agent) || agent;
  // Prefer CLI-reported thread name over initial prompt from transcript.
  const named = globalAiManager.getSession(sessionId)?.threadTitle;
  // With a recorded id the title is exact; without one (hook reports no id) the
  // history list's prompt/cwd heuristic is the only signal — same single-candidate
  // rule the modal itself tags rows with.
  const matched = conv
    ? conversationTitle(engine, conv.id, cwd)
    : matchLiveSessions(rows, liveHistoryRows(sessions)).find((r) => r.openSessionId === sessionId)?.title || "";
  let title = named || matched;
  if (!title && conv) {
    await listAgentSessions({ cwd, fresh: true });
    title = conversationTitle(engine, conv.id, cwd);
  }
  if (!title) {
    title = matchLiveSessions(rows, liveHistoryRows(sessions)).find((r) => r.openSessionId === sessionId)?.title || "";
  }
  const name = fitName(title);
  if (!name || name === session.name) return false;
  session.name = name;
  session.autoNamed = true;
  broadcast(io, "session-renamed", { sessionId, name });
  return true;
}

// Sync auto-named terminal titles with their active conversation names.
export async function syncAutoNames(io, sessions, sessionId = null) {
  const ids = sessionId ? [sessionId] : [...sessions.keys()];
  let changed = false;
  for (const id of ids) {
    if (await nameOneSession(io, sessions, id)) changed = true;
  }
  if (changed) saveSessionMetadata(sessions);
}

// The conversation follows the terminal's new name: through the adapter when the
// chat pane owns the CLI, else as the TUI's own rename command typed into the PTY.
// Terminal-mode needs a tracked conversation (its CLI still owns the terminal) and
// an engine with a TUI rename — anything else keeps the name on our side only.
async function pushRenameToConversation(sessions, sessionId, rawName) {
  // The name rides a PTY input line and RPC payloads — control chars are noise there.
  const name = String(rawName || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, SESSION_NAME_MAX);
  if (!name) return;
  const ai = globalAiManager.getSession(sessionId);
  if (ai) {
    await ai.renameConversation(name);
    return;
  }
  const conv = getConversation(sessionId);
  if (!conv) return;
  const agentId = engineFromAgent(conv.agent) || conv.agent;
  const cmd = agentRenameCommand(agentId);
  if (!cmd) return;
  const session = sessions.get(sessionId);
  // The tracked conversation can outlive its TUI (exit → the shell reading is not
  // confirmed yet), and a live agent's own tool can hold the foreground — only
  // the agent TUI itself in front may take the line; a miss just skips the sync.
  const foreground = session?.daemon && daemonClient.isConnected()
    ? (await daemonClient.listSessions().catch(() => [])).find((s) => s.id === sessionId)?.foregroundProcess
    : session?.pty ? path.basename(session.pty.process || "") : null;
  if (agentIdFromProcess(foreground) !== agentId) return;
  // Metachars are worthless in a title and lethal if a guard miss ever lands the
  // line in a shell — drop them from the typed line only (adapters get the full name).
  const safeName = name.replace(/[;&|`$<>\\()]/g, " ").replace(/\s+/g, " ").trim();
  if (!safeName) return;
  // CLEAR_LINE wipes whatever the user is mid-typing so the command lands whole.
  sendTerminalInput(sessionId, session, `${CLEAR_LINE}${cmd} ${safeName}\r`);
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

export function setupSessionHandlers(socket, io, sessions, workspaces, sessionWorkspaces, sessionOrder = []) {
  const persist = () => saveWorkspaces(workspaces, sessionWorkspaces, sessionOrder);

  // Both names are broadcast during transition so clients on previous versions refresh.
  const broadcastChanged = () => {
    broadcast(io, "workspacesChanged");
    broadcast(io, "groupsChanged");
  };

  // Tear down a session across daemon/PTY paths without broadcasting.
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
  sessionDestroyer = destroySession;

  socket.on("getSessions", async (callback) => {
    capsLogger.info("[diag] getSessions arrived (socket ready to answer)");
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

  const listWorkspaces = (callback) => {
    capsLogger.info(`[diag] getWorkspaces arrived+ack → ${workspaces.size} workspaces`);
    callback(Array.from(workspaces.values()));
  };

  const createWorkspace = ({ name, path: wsPath }, callback) => {
    // Validate path points to a real directory if supplied.
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
      const targetIds = Object.keys(sessionWorkspaces).filter((sid) => sessionWorkspaces[sid] === id);
      for (const sid of targetIds) {
        const session = sessions.get(sid);
        // Clean up AI session alongside terminal so process does not orphan.
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

  // List past agent CLI conversations for a directory to resume in place.
  socket.on("getAgentSessions", async ({ cwd, limit } = {}, callback) => {
    const rows = await listAgentSessions({ cwd, limit });
    callback?.({ success: true, sessions: matchLiveSessions(rows, liveHistoryRows(sessions)) });
    syncAutoNames(io, sessions);
  });

  // Claim conversation immediately on resume rather than waiting for first CLI hook.
  socket.on("claimAgentSession", ({ sessionId, agent, conversationId } = {}, callback) => {
    claimResumedConversation(sessionId, { agent, sessionId: conversationId });
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
      const workspacePath = workspace?.path || null;

      // Auto-named terminals track conversation title; user-named terminals are not renamed.
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

      if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
        const result = await daemonClient.createSession(autoName, 80, 24, shellId, sessionId, resolvedCwd);
        if (result.success) {
          if (agentId) setSessionAgent(result.sessionId, agentId);
          sessions.set(result.sessionId, { daemon: true, name: autoName, autoNamed, createdAt: Date.now(), cwd: result.cwd, workspacePath, shellId: result.shellId, shellLabel: result.shellLabel, agent: agentId });
          if (workspace) { sessionWorkspaces[result.sessionId] = workspace.id; persist(); }
          saveSessionMetadata(sessions);
          await retire({ success: true, sessionId: result.sessionId, shellLabel: result.shellLabel });
        } else {
          callback({ success: false, error: result.error });
        }
        return;
      }

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
    // Accept {sessionId, cols, rows} or legacy bare sessionId; use client size for respawned PTY.
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

    if (session.daemon && daemonClient.isConnected()) {
      try {
        // Session lost after daemon respawn → recreate PTY with same id + title + prior cwd (buffer gone, metadata kept)
        if (session.needsRespawn) {
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
    // Return current live seq so client can resync lastSeq after reset+replay.
    callback({ success: true, name: session.name, cwd: session.cwd, seq: currentSeq(sessionId) });
  });

  // Handle client capability announcement (fragOut, fragCtl) and reply with server caps.
  socket.on("caps", (caps = {}) => {
    capsLogger.debug(`[caps] client announced: ${JSON.stringify(caps)}`);
    if (caps?.fragOut) socket.data.fragOut = true;
    if (caps?.fragCtl) socket.data.fragCtl = true;
    socket.emit("srvCaps", { env2: 1, fragCtl: 1 });
  });

  // Scroll-up history fetch: emit older prefix only to the requesting socket.
  socket.on("requestHistory", async ({ sessionId, have } = {}, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback?.({ success: false, error: "Session not found" });
    if (!session.daemon || !daemonClient.isConnected()) return callback?.({ success: false, error: "History unavailable" });
    try {
      const result = await daemonClient.requestHistory(sessionId, have || 0);
      if (!result.success) return callback?.({ success: false, error: result.error });
      if (result.prefix) {
        // Slice into SCTP-safe fragments with part markers for clients supporting fragOut.
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
      const session = globalAiManager.getSession(sessionId);
      if (!session) return callback?.({ success: false, error: "Session not found" });
      const { events, hasMore } = aiHistoryChunk(session.history, before || 0, AI_REPLAY_BYTES);
      callback?.({ success: true, events, hasMore });
    } catch (e) {
      callback?.({ success: false, error: e.message });
    }
  });

  // Peek live seq on visibility change to detect gaps without waiting for new output.
  socket.on("peekSeq", ({ sessionId } = {}, callback) => {
    callback?.({ seq: currentSeq(sessionId) });
  });

  // Gap recovery: emit missing chunk range without full reset+replay; miss falls back to rejoin.
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
    const ok = await destroySession(sessionId);
    if (!ok) return callback({ success: false, error: "Could not close session" });
    broadcast(io, "sessionClosed", sessionId);
    callback({ success: true });
  });

  socket.on("renameSession", async ({ sessionId, name }, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback({ success: false, error: "Session not found" });

    try {
      session.name = name;
      // The user named this terminal: its conversation's title stops driving it.
      session.autoNamed = false;
      // And the conversation takes the name too, into its own CLI's store where it can.
      pushRenameToConversation(sessions, sessionId, name);
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
