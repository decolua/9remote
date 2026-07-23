import pty from "node-pty";
import * as daemonClient from "../ptyDaemonClient.js";
import { getDefaultShell, getDefaultCwd, buildShellEnv, saveSessionBuffer, loadSessionBuffer, deleteSessionBuffer, saveSessionMetadata, saveGroups, UPLOAD_DIR } from "../ptyHelper.js";
import { resolveShell, getShellList } from "../constants.js";
import { isCodespaces } from "../codespaceManager.js";
import { broadcast } from "../../../transport/broadcast.js";
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
    broadcast(io, "sessionClosed", sessionId);
  });
}

// sessions ref is passed in from terminalSocket to keep single source of truth.
// groups (Map) + sessionGroups (object) are agent-managed and persisted to JSON.
export function setupSessionHandlers(socket, io, sessions, groups, sessionGroups, sessionOrder = []) {
  // Persist current groups + session->group map + session order
  const persistGroups = () => saveGroups(groups, sessionGroups, sessionOrder);

  socket.on("getSessions", async (callback) => {
    const list = [];
    // Fetch live cwd for daemon sessions (OSC 7 updates daemon-side, not agent cache)
    const useDaemon = PERSISTENCE_MODE === "daemon" && daemonClient.isConnected();
    for (const [id, session] of sessions) {
      let cwd = session.cwd;
      if (useDaemon && session.daemon) {
        const liveCwd = await daemonClient.getSessionCwd(id);
        if (liveCwd) { cwd = liveCwd; if (session.cwd !== liveCwd) session.cwd = liveCwd; }
      }
      list.push({ id, name: session.name, createdAt: session.createdAt, restored: session.restored || false, shellId: session.shellId, shellLabel: session.shellLabel, groupId: sessionGroups[id] || null, cwd });
    }
    // Sort by persisted order; unranked ids (new sessions) fall to the end, stable
    const rank = new Map(sessionOrder.map((id, i) => [id, i]));
    list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
    callback(list);
  });

  socket.on("getShells", (callback) => {
    callback({ platform: process.platform, shells: getShellList() });
  });

  // Group operations — handled at agent (independent of daemon)
  socket.on("getGroups", (callback) => {
    callback(Array.from(groups.values()));
  });

  socket.on("createGroup", ({ name }, callback) => {
    const id = `group-${Date.now()}`;
    const group = { id, name: name || "Group", createdAt: Date.now() };
    groups.set(id, group);
    persistGroups();
    broadcast(io, "groupsChanged");
    callback({ success: true, group });
  });

  socket.on("renameGroup", ({ groupId, name }, callback) => {
    const group = groups.get(groupId);
    if (!group) return callback({ success: false, error: "Group not found" });
    group.name = name;
    persistGroups();
    broadcast(io, "groupsChanged");
    callback({ success: true });
  });

  socket.on("deleteGroup", async ({ groupId }, callback) => {
    if (!groups.delete(groupId)) return callback({ success: false, error: "Group not found" });
    // Close all terminals belonging to this group
    const targetIds = Object.keys(sessionGroups).filter((sid) => sessionGroups[sid] === groupId);
    for (const sid of targetIds) {
      const session = sessions.get(sid);
      if (session) {
        if (session.daemon && daemonClient.isConnected()) {
          try { await daemonClient.deleteSession(sid); } catch {}
        } else if (session.pty) {
          session.pty.kill();
          deleteSessionBuffer(sid);
        }
        sessions.delete(sid);
        broadcast(io, "sessionClosed", sid);
      }
      delete sessionGroups[sid];
    }
    persistGroups();
    broadcast(io, "groupsChanged");
    callback({ success: true });
  });

  socket.on("moveSession", ({ sessionId, groupId }, callback) => {
    if (groupId && groups.has(groupId)) sessionGroups[sessionId] = groupId;
    else delete sessionGroups[sessionId];
    persistGroups();
    broadcast(io, "groupsChanged");
    callback({ success: true });
  });

  // Reorder sessions within a group. orderedIds = desired order of that group's sessions.
  socket.on("reorderSession", ({ orderedIds }, callback) => {
    if (!Array.isArray(orderedIds)) return callback?.({ success: false, error: "orderedIds required" });
    const moving = new Set(orderedIds);
    // Rebuild global order: keep others in place, splice the group's ids into their first slot
    const rest = sessionOrder.filter((id) => !moving.has(id));
    const others = [...sessions.keys()].filter((id) => !moving.has(id) && !rest.includes(id));
    sessionOrder.length = 0;
    sessionOrder.push(...rest, ...others, ...orderedIds);
    persistGroups();
    broadcast(io, "groupsChanged");
    callback?.({ success: true });
  });

  socket.on("createSession", async ({ name, shellId, groupId, cwd }, callback) => {
    const sessionId = `session-${Date.now()}`;
    const shellConfig = resolveShell(shellId);
    const shellEnv = buildShellEnv();
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;
    // Inherit cwd from last session in group (client-supplied); validate at this trust
    // boundary — fall back to default if missing or not an existing directory.
    const resolvedCwd = (cwd && fs.existsSync(cwd)) ? cwd : getDefaultCwd(isCodespaces());

    try {
      // Auto-name "Term N" if user didn't provide a custom name (cross-platform)
      const autoName = name || `Term ${sessions.size + 1}`;

      // Daemon mode
      if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
        const result = await daemonClient.createSession(autoName, 80, 24, shellId, sessionId, resolvedCwd);
        if (result.success) {
          sessions.set(result.sessionId, { daemon: true, name: autoName, createdAt: Date.now(), cwd: result.cwd, shellId: result.shellId, shellLabel: result.shellLabel });
          if (groupId && groups.has(groupId)) { sessionGroups[result.sessionId] = groupId; persistGroups(); }
          saveSessionMetadata(sessions);
          callback({ success: true, sessionId: result.sessionId, shellLabel: result.shellLabel });
        } else {
          callback({ success: false, error: result.error });
        }
        return;
      }

      // Buffer mode PTY
      const ptyProcess = pty.spawn(shellConfig.path, shellConfig.args, { name: "xterm-256color", cols: 80, rows: 24, cwd: resolvedCwd, env: shellEnv, useConpty: false });
      const sessionData = { pty: ptyProcess, name: autoName, createdAt: Date.now(), buffer: [], cwd: resolvedCwd, shellId: shellConfig.id, shellLabel: shellConfig.label };

      attachPtyListeners(ptyProcess, sessionId, sessionData, io, sessions);
      sessions.set(sessionId, sessionData);
      if (groupId && groups.has(groupId)) { sessionGroups[sessionId] = groupId; persistGroups(); }
      callback({ success: true, sessionId, shellLabel: shellConfig.label });
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
      socket.emit("output", { sessionId, data: Buffer.from(takeBufferTail(session.buffer, JOIN_REPLAY_SIZE), "utf-8") });
    }
    callback({ success: true, name: session.name, cwd: session.cwd });
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
        socket.emit("output", { sessionId, enc: "b64", isHistoryPrefix: true, data: result.prefix });
      }
      callback?.({ success: true, prefixLen: result.prefixLen || 0, total: result.total || 0, remaining: result.remaining || 0 });
    } catch (e) {
      callback?.({ success: false, error: e.message });
    }
  });

  socket.on("deleteSession", async (sessionId, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback({ success: false, error: "Session not found" });

    if (session.daemon && daemonClient.isConnected()) {
      try {
        await daemonClient.deleteSession(sessionId);
        sessions.delete(sessionId);
        if (sessionGroups[sessionId]) { delete sessionGroups[sessionId]; persistGroups(); }
        saveSessionMetadata(sessions);
        callback({ success: true });
      } catch (e) {
        callback({ success: false, error: e.message });
      }
      return;
    }

    if (session.pty) session.pty.kill();
    sessions.delete(sessionId);
    if (sessionGroups[sessionId]) { delete sessionGroups[sessionId]; persistGroups(); }
    deleteSessionBuffer(sessionId);
    broadcast(io, "sessionClosed", sessionId);
    saveSessionMetadata(sessions);
    callback({ success: true });
  });

  socket.on("renameSession", async ({ sessionId, name }, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback({ success: false, error: "Session not found" });

    // Name is agent-owned (single source of truth) for both daemon and buffer mode
    session.name = name;
    broadcast(io, "session-renamed", { sessionId, name });
    saveSessionMetadata(sessions);
    callback({ success: true });
  });
}
