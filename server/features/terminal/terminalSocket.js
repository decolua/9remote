// Terminal Socket.IO namespace
import pty from "node-pty";
import chalk from "chalk";
import { isRemoteAvailable } from "../remote/remoteSocket.js";
import * as daemonClient from "./ptyDaemonClient.js";
import { enableToolHook, disableToolHook, getHookStatus } from "./hookManager.js";
import { getVapidPublicKey, addPushSubscription, removePushSubscription, markSubscriptionDisconnected, markSubscriptionConnected } from "./pushManager.js";
import { isCodespaces, getCodespaceInfo, trackConnection, trackDisconnection, getAutoStartStatus, setAutoStart } from "./codespaceManager.js";
import { getDefaultShell, getDefaultCwd, buildShellEnv, saveSessionBuffer, loadSessionBuffer, deleteSessionBuffer, listSavedBufferSessions, loadSessionMetadata, saveSessionMetadata, UPLOAD_DIR } from "./ptyHelper.js";
import { addNotification, clearNotification, getNotifications } from "./notificationManager.js";
import fs from "fs";
import path from "path";

const ORANGE = chalk.rgb(230, 138, 110);

// Store sessions: sessionId -> { pty, name, createdAt, buffer, daemon }
const sessions = new Map();

// Persistence mode:
// - "daemon": PTY Daemon (persistent + scrollback) ⭐ Recommended
// - "buffer": PTY + file persistence (scrollback, no process persistence)
const PERSISTENCE_MODE = "daemon";

/**
 * Initialize terminal sessions on server start
 */
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

export function setupTerminalSocket(io) {
  // Forward daemon events to socket clients
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
    console.log(`📟 Terminal client connected: ${socket.id}`);
    trackConnection();

    // Send current badge state after client signals ready
    socket.on("getNotificationState", () => {
      socket.emit("notificationState", getNotifications());
    });

    socket.emit("serverInfo", {
      remoteAvailable: isRemoteAvailable(),
      daemonMode: PERSISTENCE_MODE === "daemon" && daemonClient.isConnected(),
      platform: process.platform,
      ...getCodespaceInfo()
    });

    socket.on("getSessions", (callback) => {
      const list = [];
      for (const [id, session] of sessions) {
        list.push({ id, name: session.name, createdAt: session.createdAt, restored: session.restored || false });
      }
      callback(list);
    });

    socket.on("createSession", async ({ name }, callback) => {
      const sessionId = `session-${Date.now()}`;
      const shellEnv = buildShellEnv();
      shellEnv.NINE_REMOTE_SESSION_ID = sessionId;
      const cwd = getDefaultCwd(isCodespaces());

      try {
        // Daemon mode
        if (PERSISTENCE_MODE === "daemon" && daemonClient.isConnected()) {
          const result = await daemonClient.createSession(name, 80, 24);
          if (result.success) {
            sessions.set(result.sessionId, { daemon: true, name: name || `Terminal ${sessions.size + 1}`, createdAt: Date.now(), cwd: result.cwd });
            callback({ success: true, sessionId: result.sessionId });
          } else {
            callback({ success: false, error: result.error });
          }
          return;
        }

        // Buffer mode PTY
        const shell = getDefaultShell();
        const shellArgs = process.platform === "win32" ? [] : ["-l"];
        const ptyProcess = pty.spawn(shell, shellArgs, { name: "xterm-256color", cols: 80, rows: 24, cwd, env: shellEnv, useConpty: false });

        const sessionData = { pty: ptyProcess, name: name || `Terminal ${sessions.size + 1}`, createdAt: Date.now(), buffer: [], cwd };
        const MAX_BUFFER = 50 * 1024;
        let saveTimeout = null;

        ptyProcess.onData((data) => {
          sessionData.buffer.push(data);
          let size = sessionData.buffer.reduce((s, c) => s + c.length, 0);
          while (size > MAX_BUFFER && sessionData.buffer.length > 1) size -= sessionData.buffer.shift().length;
          io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
          if (PERSISTENCE_MODE === "buffer") {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => saveSessionBuffer(sessionId, sessionData.buffer, PERSISTENCE_MODE), 2000);
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
          if (PERSISTENCE_MODE === "buffer" && sessionData.buffer.length > 0) saveSessionBuffer(sessionId, sessionData.buffer, PERSISTENCE_MODE);
          sessions.delete(sessionId);
          deleteSessionBuffer(sessionId);
          io.emit("sessionClosed", sessionId);
        });

        console.log(`PTY created: sessionId=${sessionId}, name=${name}`);
        sessions.set(sessionId, sessionData);
        callback({ success: true, sessionId });
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
          const result = await daemonClient.joinSession(sessionId);
          callback({ success: result.success, name: result.name, cwd: result.cwd, error: result.error });
        } catch (e) {
          callback({ success: false, error: e.message });
        }
        return;
      }

      // Buffer mode: restore PTY
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

          const MAX_BUFFER = 50 * 1024;
          let saveTimeout = null;

          ptyProcess.onData((data) => {
            session.buffer.push(data);
            let size = session.buffer.reduce((s, c) => s + c.length, 0);
            while (size > MAX_BUFFER && session.buffer.length > 1) size -= session.buffer.shift().length;
            io.emit("output", { sessionId, data: Buffer.from(data, "utf-8") });
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => saveSessionBuffer(sessionId, session.buffer, PERSISTENCE_MODE), 2000);
          });

          ptyProcess.onExit(({ exitCode }) => {
            console.log(`PTY exited: sessionId=${sessionId}, code=${exitCode}`);
            if (session.buffer.length > 0) saveSessionBuffer(sessionId, session.buffer, PERSISTENCE_MODE);
            sessions.delete(sessionId);
            deleteSessionBuffer(sessionId);
            io.emit("sessionClosed", sessionId);
          });

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

    socket.on("input", ({ sessionId, data }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
      if (session.pty) session.pty.write(Buffer.isBuffer(data) ? data.toString("utf-8") : data);
    });

    socket.on("upload-file", ({ sessionId, filename, size, content }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      try {
        const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFilename}`);
        fs.writeFileSync(filePath, Buffer.from(content, "base64"));
        console.log(`📎 File uploaded: ${filePath} (${size} bytes)`);
        if (session.daemon && daemonClient.isConnected()) daemonClient.sendInput(sessionId, filePath);
        else if (session.pty) session.pty.write(filePath);
      } catch (error) {
        console.error("File upload error:", error);
        socket.emit("output", { sessionId, data: Buffer.from(`\r\nError uploading file: ${error.message}\r\n`, "utf-8") });
      }
    });

    socket.on("resize", ({ sessionId, cols, rows }) => {
      if (!sessionId) return;
      const session = sessions.get(sessionId);
      if (!session) return;
      if (session.daemon && daemonClient.isConnected()) return daemonClient.resizeSession(sessionId, cols, rows);
      if (session.pty) {
        try { session.pty.resize(cols, rows); } catch (e) { console.log(`Resize failed for ${sessionId}: ${e.message}`); }
      }
    });

    socket.on("deleteSession", async (sessionId, callback) => {
      const session = sessions.get(sessionId);
      if (!session) return callback({ success: false, error: "Session not found" });
      if (session.daemon && daemonClient.isConnected()) {
        try {
          await daemonClient.deleteSession(sessionId);
          sessions.delete(sessionId);
          callback({ success: true });
        } catch (e) { callback({ success: false, error: e.message }); }
        return;
      }
      if (session.pty) session.pty.kill();
      sessions.delete(sessionId);
      deleteSessionBuffer(sessionId);
      io.emit("sessionClosed", sessionId);
      saveSessionMetadata(sessions);
      callback({ success: true });
    });

    socket.on("renameSession", async ({ sessionId, name }, callback) => {
      const session = sessions.get(sessionId);
      if (!session) return callback({ success: false, error: "Session not found" });
      if (session.daemon && daemonClient.isConnected()) {
        try {
          await daemonClient.renameSession(sessionId, name);
          session.name = name;
          callback({ success: true });
        } catch (e) { callback({ success: false, error: e.message }); }
        return;
      }
      session.name = name;
      io.emit("session-renamed", { sessionId, name });
      saveSessionMetadata(sessions);
      callback({ success: true });
    });

    socket.on("enableHook", async ({ tool }, callback) => {
      try { callback(await enableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); }
    });

    socket.on("disableHook", async ({ tool }, callback) => {
      try { callback(await disableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); }
    });

    socket.on("getHookStatus", (callback) => callback(getHookStatus()));

    socket.on("getVapidKey", (callback) => callback(getVapidPublicKey()));

    socket.on("pushSubscribe", (subscription) => {
      if (!subscription?.endpoint) return;
      // addPushSubscription deduplicates by endpoint, markSubscriptionConnected updates socketId
      markSubscriptionConnected(socket.id, subscription.endpoint);
      addPushSubscription(subscription, socket.id);
    });

    socket.on("pushUnsubscribe", (endpoint) => { if (endpoint) removePushSubscription(endpoint); });

    // Clear badge for a session (broadcast to all clients)
    socket.on("clearNotification", (sessionId) => {
      if (sessionId) {
        clearNotification(sessionId);
        socket.broadcast.emit("notificationCleared", sessionId);
      }
    });

    socket.on("getAutoStartStatus", (callback) => {
      if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
      const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
      callback({ success: true, ...getAutoStartStatus(workspacePath) });
    });

    socket.on("setAutoStart", ({ enabled }, callback) => {
      if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
      const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
      callback(setAutoStart(workspacePath, enabled));
    });

    socket.on("disconnect", () => {
      console.log(`📟 Terminal client disconnected: ${socket.id}`);
      markSubscriptionDisconnected(socket.id);
      trackDisconnection();
    });
  });
}
