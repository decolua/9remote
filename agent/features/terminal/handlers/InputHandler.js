import * as daemonClient from "../ptyDaemonClient.js";
import { UPLOAD_DIR, saveSessionMetadata } from "../ptyHelper.js";
import { getClaudeSessionId, isClaudeYolo, setClaudeYolo } from "../statusManager.js";
import { CLAUDE_YOLO_FLAG } from "../agentCatalog.js";
import { setClipboardFromFile } from "../../../lib/clipboardSystem.js";
import fs from "fs";
import path from "path";

const PERSISTENCE_MODE = "daemon";
const PASTE_KEY = "\x16"; // Ctrl+V — tell the CLI to read the OS clipboard
const RESUME_EXIT_MS = 2000; // wait for claude to exit before relaunching the conversation

// Keystrokes arrive piecemeal, so rebuild the current line to spot claude launch
// lines (modal send is one chunk, hand typing is many). Capped so a running TUI
// can't grow the buffer forever; dropped once the line is evaluated on Enter.
const INPUT_LINE_CAP = 256;
const inputLines = new Map(); // sessionId -> partial line since last Enter

function evalClaudeLine(sessionId, line) {
  if (!CLAUDE_YOLO_FLAG || !/^\s*claude\b/.test(line)) return;
  setClaudeYolo(sessionId, line.includes(CLAUDE_YOLO_FLAG));
}

function trackClaudeYolo(sessionId, data) {
  if (typeof data !== "string" || !data) return;
  const line = (inputLines.get(sessionId) || "") + data;
  if (data.includes("\r") || data.includes("\n")) {
    for (const part of line.split(/\r\n|\r|\n/)) evalClaudeLine(sessionId, part);
    inputLines.delete(sessionId);
  } else {
    inputLines.set(sessionId, line.slice(-INPUT_LINE_CAP));
  }
}

// Debounce metadata writes on resize so rapid layout changes don't write the file
// on every event — but the last size always lands before the next agent restart.
let resizeSaveTimer = null;
const RESIZE_SAVE_DEBOUNCE_MS = 500;
function persistSessionsDebounced(sessions) {
  if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
  resizeSaveTimer = setTimeout(() => { resizeSaveTimer = null; saveSessionMetadata(sessions); }, RESIZE_SAVE_DEBOUNCE_MS);
}

export function setupInputHandlers(socket, sessions) {
  socket.on("input", ({ sessionId, data }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    trackClaudeYolo(sessionId, data);
    if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
    if (session.pty) session.pty.write(Buffer.isBuffer(data) ? data.toString("utf-8") : data);
  });

  socket.on("resize", ({ sessionId, cols, rows }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Track last client size so a respawned PTY (daemon restart) inherits it instead of 80×24.
    session.lastCols = cols;
    session.lastRows = rows;
    persistSessionsDebounced(sessions); // survive agent restart too (R1 v2)
    if (session.daemon && daemonClient.isConnected()) return daemonClient.resizeSession(sessionId, cols, rows);
    if (session.pty) {
      try { session.pty.resize(cols, rows); } catch (e) { console.log(`Resize failed for ${sessionId}: ${e.message}`); }
    }
  });

  // Resume the exact claude conversation of this session: Claude Code hard-wraps output
  // at launch width, so after a layout change the only true fix is exit + `--resume <id>`,
  // which re-renders the whole transcript at the current PTY size.
  socket.on("session-resume", ({ sessionId }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const csid = getClaudeSessionId(sessionId);
    if (!csid) return;
    const send = (data) => {
      if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
      if (session.pty) session.pty.write(data);
    };
    send("\x03\x03"); // Ctrl+C x2 — exit claude
    // Re-apply the skip-permission flag when the conversation was launched with it —
    // --resume alone resets to default (per-action approval) mode.
    const yoloFlag = isClaudeYolo(sessionId) ? ` ${CLAUDE_YOLO_FLAG}` : "";
    setTimeout(() => send(`claude --resume ${csid}${yoloFlag}\r`), RESUME_EXIT_MS);
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
