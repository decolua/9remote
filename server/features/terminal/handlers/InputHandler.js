import * as daemonClient from "../ptyDaemonClient.js";
import { UPLOAD_DIR } from "../ptyHelper.js";
import fs from "fs";
import path from "path";

const PERSISTENCE_MODE = "daemon";

export function setupInputHandlers(socket, sessions) {
  socket.on("input", ({ sessionId, data }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
    if (session.pty) session.pty.write(Buffer.isBuffer(data) ? data.toString("utf-8") : data);
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
}
