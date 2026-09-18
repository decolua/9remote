import * as daemonClient from "../ptyDaemonClient.js";
import { UPLOAD_DIR, saveSessionMetadata } from "../ptyHelper.js";
import { getConversation, setSessionAgent, setConversationId, setLastPrompt } from "../statusManager.js";
import { agentIdFromLaunchLine, parseResumeLine } from "../agentCatalog.js";
import { resumeCommand } from "../agentHistory.js";
import { engineFromAgent } from "../conversationModes.js";
import { RESIZE_MIN_COLS, RESIZE_MIN_ROWS, RESIZE_MAX_COLS, RESIZE_MAX_ROWS, RESIZE_SHRINK_SETTLE_MS } from "../constants.js";
import { setClipboardFromFile } from "../../../lib/clipboardSystem.js";
import fs from "fs";
import path from "path";

const PERSISTENCE_MODE = "daemon";
const PASTE_KEY = "\x16"; // Ctrl+V — tell the CLI to read the OS clipboard
const RESUME_EXIT_MS = 2000; // wait for claude to exit before relaunching the conversation
const CLEAR_LINE = process.platform === "win32" ? "\x1b" : "\x05\x15";

// Keystrokes arrive piecemeal, so rebuild the current line to spot agent launch
// lines (modal send is one chunk, hand typing is many). Capped so a running TUI
// can't grow the buffer forever; dropped once the line is evaluated on Enter.
const INPUT_LINE_CAP = 256;
const inputLines = new Map(); // sessionId -> partial line since last Enter

function evalLaunchLine(sessionId, line) {
  // A typed resume line carries the conversation id verbatim — recorded on the
  // spot, before any hook fires (and for CLIs whose hooks report no id at all).
  const resumed = parseResumeLine(line);
  if (resumed) {
    setConversationId(sessionId, resumed.agent, resumed.id, "resume");
    setSessionAgent(sessionId, resumed.agent);
    return;
  }
  const agentId = agentIdFromLaunchLine(line);
  if (agentId) return setSessionAgent(sessionId, agentId);
  // Not a launch line: with a TUI agent running this is the user's prompt, the
  // only prompt signal that exists without a hook. setLastPrompt drops it when
  // no agent is running and when the text isn't clean.
  setLastPrompt(sessionId, line);
}

function trackLaunchLine(sessionId, data) {
  if (typeof data !== "string" || !data) return;
  const line = (inputLines.get(sessionId) || "") + data;
  if (data.includes("\r") || data.includes("\n")) {
    for (const part of line.split(/\r\n|\r|\n/)) evalLaunchLine(sessionId, part);
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

const isSaneSize = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Pending shrink per session — a later resize (in either direction) supersedes it.
const shrinkTimers = new Map();

function clearShrink(sessionId) {
  const t = shrinkTimers.get(sessionId);
  if (!t) return;
  clearTimeout(t);
  shrinkTimers.delete(sessionId);
}

// Apply a validated size to the PTY and remember it, so a respawn (daemon restart)
// inherits the real size instead of 80×24. Only reached for sizes that survived
// both the sanity floor and the shrink settle window.
function applyResize(sessions, sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.lastCols = cols;
  session.lastRows = rows;
  persistSessionsDebounced(sessions);
  if (session.daemon && daemonClient.isConnected()) return daemonClient.resizeSession(sessionId, cols, rows);
  if (session.pty) {
    try { session.pty.resize(cols, rows); } catch (e) { console.log(`Resize failed for ${sessionId}: ${e.message}`); }
  }
}

export function setupInputHandlers(socket, sessions) {
  socket.on("input", ({ sessionId, data }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    trackLaunchLine(sessionId, data);
    if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
    if (session.pty) session.pty.write(Buffer.isBuffer(data) ? data.toString("utf-8") : data);
  });

  socket.on("resize", ({ sessionId, cols, rows }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Reject sizes no real layout produces — a pane measured mid-transition, or a
    // malformed payload. Emitting them would re-wrap scrollback narrow forever.
    if (!isSaneSize(cols, RESIZE_MIN_COLS, RESIZE_MAX_COLS)) return;
    if (!isSaneSize(rows, RESIZE_MIN_ROWS, RESIZE_MAX_ROWS)) return;

    // Any newer size supersedes a shrink still waiting out its window.
    clearShrink(sessionId);
    if (cols >= (session.lastCols ?? 0)) return applyResize(sessions, sessionId, cols, rows);

    // Narrower than current: hold it. A transient dip (panel slide, soft keyboard)
    // is followed by the real size before the window elapses, and that later call
    // clears this timer — so only a size the client actually settled on lands.
    shrinkTimers.set(sessionId, setTimeout(() => {
      shrinkTimers.delete(sessionId);
      applyResize(sessions, sessionId, cols, rows);
    }, RESIZE_SHRINK_SETTLE_MS));
  });

  // Resume the exact conversation this session is running: a TUI agent hard-wraps
  // output at launch width, so after a layout change the only true fix is exit +
  // the CLI's own resume line, which re-renders the transcript at the current size.
  socket.on("session-resume", ({ sessionId }) => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const conv = getConversation(sessionId);
    // The engine, not the surface: a chat session records "claude-ui", and resumeCommand
    // only knows engine ids — it would answer null and the CLI would exit unrecovered.
    const line = conv && resumeCommand(engineFromAgent(conv.agent), conv.id, true);
    if (!line) return;
    const send = (data) => {
      if (session.daemon && daemonClient.isConnected()) return daemonClient.sendInput(sessionId, data);
      if (session.pty) session.pty.write(data);
    };
    send("\x03\x03"); // Ctrl+C x2 — exit the running TUI
    // Clear any leaked terminal responses or dirty chars on the prompt before typing resume line
    setTimeout(() => send(`${CLEAR_LINE}${line}\r`), RESUME_EXIT_MS);
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
      socket.emit("output", { sessionId, enc: "bin", data: Buffer.from(`\r\nError uploading file: ${error.message}\r\n`, "utf-8") });
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
