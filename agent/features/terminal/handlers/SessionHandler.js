import pty from "node-pty";
import * as daemonClient from "../ptyDaemonClient.js";
import { getDefaultShell, getDefaultCwd, buildShellEnv, saveSessionBuffer, loadSessionBuffer, deleteSessionBuffer, saveSessionMetadata, saveGroups, UPLOAD_DIR } from "../ptyHelper.js";
import { resolveShell, getShellList } from "../constants.js";
import { isCodespaces } from "../codespaceManager.js";
import { broadcast } from "../../../transport/broadcast.js";
import fs from "fs";
import path from "path";

const MAX_BUFFER = 2 * 1024 * 1024;
const PERSISTENCE_MODE = "daemon";

/**
 * Setup PTY data listeners — shared between createSession and joinSession (buffer mode).
 */
function attachPtyListeners(ptyProcess, sessionId, sessionData, io, sessions) {
  let saveTimeout = null;

  ptyProcess.onData((data) => {
    sessionData.buffer.push(data);
    // Trim by char length keeping the tail — avoids cutting whole chunks mid-ANSI
    const size = sessionData.buffer.reduce((s, c) => s + c.length, 0);
    if (size > MAX_BUFFER) sessionData.buffer = [sessionData.buffer.join("").slice(-MAX_BUFFER)];
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
export function setupSessionHandlers(socket, io, sessions, groups, sessionGroups) {
  // Persist current groups + session->group map
  const persistGroups = () => saveGroups(groups, sessionGroups);

  socket.on("getSessions", (callback) => {
    const list = [];
    for (const [id, session] of sessions) {
      list.push({ id, name: session.name, createdAt: session.createdAt, restored: session.restored || false, shellId: session.shellId, shellLabel: session.shellLabel, groupId: sessionGroups[id] || null });
    }
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

  socket.on("createSession", async ({ name, shellId, groupId }, callback) => {
    const sessionId = `session-${Date.now()}`;
    const shellConfig = resolveShell(shellId);
    const shellEnv = buildShellEnv();
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;
    const cwd = getDefaultCwd(isCodespaces());

    try {
      // Auto-name from shell label if user didn't provide a custom name
      const autoName = name || `${shellConfig.label} ${sessions.size + 1}`;

      // Daemon mode
      if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
        const result = await daemonClient.createSession(autoName, 80, 24, shellId, sessionId, cwd);
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
      const ptyProcess = pty.spawn(shellConfig.path, shellConfig.args, { name: "xterm-256color", cols: 80, rows: 24, cwd, env: shellEnv, useConpty: false });
      const sessionData = { pty: ptyProcess, name: autoName, createdAt: Date.now(), buffer: [], cwd, shellId: shellConfig.id, shellLabel: shellConfig.label };

      attachPtyListeners(ptyProcess, sessionId, sessionData, io, sessions);
      sessions.set(sessionId, sessionData);
      if (groupId && groups.has(groupId)) { sessionGroups[sessionId] = groupId; persistGroups(); }
      callback({ success: true, sessionId, shellLabel: shellConfig.label });
    } catch (error) {
      console.error("Failed to create session:", error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on("joinSession", async (sessionId, callback) => {
    const session = sessions.get(sessionId);
    if (!session) return callback({ success: false, error: "Session not found" });

    // Daemon mode
    if (session.daemon && daemonClient.isConnected()) {
      try {
        // Session lost after daemon respawn → recreate PTY with same id + title + prior cwd (buffer gone, metadata kept)
        if (session.needsRespawn) {
          const created = await daemonClient.createSession(session.name, 80, 24, session.shellId, sessionId, session.cwd);
          if (!created.success) return callback({ success: false, error: created.error });
          delete session.needsRespawn;
          session.cwd = created.cwd;
          session.shellLabel = created.shellLabel;
          saveSessionMetadata(sessions);
        }
        const result = await daemonClient.joinSession(sessionId);
        // Persist live cwd (user may have cd'd) — agent is source of truth
        if (result.cwd && result.cwd !== session.cwd) { session.cwd = result.cwd; saveSessionMetadata(sessions); }
        callback({ success: result.success, name: session.name, cwd: result.cwd || session.cwd, error: result.error });
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
      socket.emit("output", { sessionId, data: Buffer.from(session.buffer.join(""), "utf-8") });
    }
    callback({ success: true, name: session.name, cwd: session.cwd });
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
