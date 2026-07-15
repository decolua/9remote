import * as daemonClient from "../ptyDaemonClient.js";
import { UPLOAD_DIR } from "../ptyHelper.js";
import { setClipboardFromFile } from "../../../lib/clipboardSystem.js";
import { trace } from "../ptyTrace.js";
import fs from "fs";
import path from "path";

const PERSISTENCE_MODE = "daemon";
const PASTE_KEY = "\x16"; // Ctrl+V — tell the CLI to read the OS clipboard

export function setupInputHandlers(socket, sessions) {
  socket.on("input", ({ sessionId, data }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const preview = typeof data === "string" ? data.replace(/\r/g, "\\r").slice(0, 12) : `[${data?.length}b]`;
    trace("agent.input.recv", `sid=${sessionId.slice(-6)} data="${preview}"`);
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

  // Attach a pasted image/file into the CLI, mirroring a real host paste:
  //  - image → OS clipboard + Ctrl+V (CLI reads image bytes → [Image #N])
  //  - file  → write to disk + type its path (CLI reads the file reference/path)
  // Ack lets web send attachments serially so the CLI consumes each before the next.
  socket.on("clipboard-attach", async ({ sessionId, filename, type, content }, ack) => {
    if (!sessionId) return ack?.({ success: false, error: "no session" });
    const session = sessions.get(sessionId);
    if (!session) return ack?.({ success: false, error: "no session" });
    try {
      const safeFilename = (filename || "paste").replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFilename}`);
      fs.writeFileSync(filePath, Buffer.from(content, "base64"));
      const isImage = typeof type === "string" && type.startsWith("image/");
      let data;
      if (isImage) {
        await setClipboardFromFile(filePath, type);
        data = PASTE_KEY;
      } else {
        // Trailing space separates the path from any following text/next path.
        data = `${filePath} `;
      }
      if (session.daemon && daemonClient.isConnected()) daemonClient.sendInput(sessionId, data);
      else if (session.pty) session.pty.write(data);
      ack?.({ success: true });
    } catch (error) {
      console.error("Clipboard attach error:", error);
      ack?.({ success: false, error: error.message });
    }
  });
}
