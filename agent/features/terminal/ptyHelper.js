// PTY shell environment + buffer/session persistence helpers
import os from "os";
import fs from "fs";
import path from "path";
import { conversationMetadata, getSessionAgent } from "./statusManager.js";
import { PATHS } from "../../lib/constants.js";

const BUFFER_DIR = PATHS.BUFFERS;
const SESSION_METADATA_FILE = path.join(PATHS.STATE, "sessions.json");
const GROUPS_FILE = path.join(PATHS.STATE, "terminalGroups.json");
const WORKSPACES_FILE = path.join(PATHS.STATE, "terminalWorkspaces.json");
const NOTES_DIR = path.join(PATHS.STATE, "notes");

export const UPLOAD_DIR = "/tmp/9remote-uploads";

// Ensure upload dir exists on import
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================
// Shell environment
// ============================================

export function getDefaultShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

export function getDefaultCwd(isCodespaces) {
  return isCodespaces ? "/workspaces" : os.homedir();
}

export function buildShellEnv() {
  const home = os.homedir();
  const user = os.userInfo().username;
  const shell = getDefaultShell();
  const env = { ...process.env };
  // Don't leak 9remote's internal PORT=2208 into user shells (breaks their npm run dev)
  delete env.PORT;

  Object.assign(env, {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: shell,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
    PWD: home,
    OLDPWD: home,
    TMPDIR: env.TMPDIR || (process.platform === "win32" ? env.TEMP || env.TMP : "/tmp"),
    __CF_USER_TEXT_ENCODING: env.__CF_USER_TEXT_ENCODING,
    XPC_FLAGS: env.XPC_FLAGS,
    XPC_SERVICE_NAME: env.XPC_SERVICE_NAME,
    SSH_AUTH_SOCK: env.SSH_AUTH_SOCK,
    TERM_PROGRAM: "9Remote",
    TERM_PROGRAM_VERSION: "1.0.0",
    ITERM_SESSION_ID: `9remote-${Date.now()}`,
    SHLVL: "1"
  });

  // Inject shell integration to track working directory via OSC 7
  if (shell.includes("bash")) {
    const existingPrompt = env.PROMPT_COMMAND || "";
    env.PROMPT_COMMAND = `printf "\\e]7;file://%s\\a" "\${HOSTNAME}\${PWD}"${existingPrompt ? `; ${existingPrompt}` : ""}`;
  }

  return env;
}

// ============================================
// Buffer persistence (buffer mode only)
// ============================================

function ensureBufferDir() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
}

export function saveSessionBuffer(sessionId, buffer, persistenceMode) {
  if (persistenceMode !== "buffer") return;
  ensureBufferDir();
  try {
    fs.writeFileSync(path.join(BUFFER_DIR, `${sessionId}.buf`), buffer.join(""), "utf8");
  } catch (error) {
    console.log(`⚠️  Failed to save buffer for ${sessionId}:`, error.message);
  }
}

export function loadSessionBuffer(sessionId, persistenceMode) {
  if (persistenceMode !== "buffer") return null;
  const filePath = path.join(BUFFER_DIR, `${sessionId}.buf`);
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.log(`⚠️  Failed to load buffer for ${sessionId}:`, error.message);
  }
  return null;
}

export function deleteSessionBuffer(sessionId) {
  const filePath = path.join(BUFFER_DIR, `${sessionId}.buf`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore
  }
}

export function listSavedBufferSessions() {
  ensureBufferDir();
  try {
    return fs.readdirSync(BUFFER_DIR)
      .filter(f => f.endsWith(".buf"))
      .map(f => f.replace(".buf", ""));
  } catch {
    return [];
  }
}

// ============================================
// Session metadata persistence
// ============================================

export function loadSessionMetadata() {
  try {
    if (fs.existsSync(SESSION_METADATA_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_METADATA_FILE, "utf8"));
    }
  } catch (error) {
    console.log("⚠️  Failed to load session metadata:", error.message);
  }
  return {};
}

// Serialize a single session to its metadata record. Exported for testing.
// Persist cols/rows (from client's last resize) so a respawned PTY after an agent
// restart inherits the real terminal size instead of falling back to 80×24.
export function buildSessionMetadata(session, sessionId) {
  return {
    name: session.name,
    // Whether the name is still ours to change: an auto-named terminal follows
    // its conversation's title, a user-named one never does.
    autoNamed: session.autoNamed !== false,
    createdAt: session.createdAt,
    shellId: session.shellId,
    cwd: session.cwd,
    // Fixed workspace root, unlike cwd which follows the user's `cd`
    workspacePath: session.workspacePath ?? null,
    cols: session.lastCols ?? session.cols ?? null,
    rows: session.lastRows ?? session.rows ?? null,
    agent: session.agent || (sessionId ? getSessionAgent(sessionId) : null) || null,
    // The agent CLI and conversation this terminal is running: the PTY survives
    // an agent restart, so the link to its chat has to survive with it.
    ...(sessionId ? conversationMetadata(sessionId) || {} : {}),
  };
}

// Write an already-built metadata object. Used by the group->workspace migration, which
// runs before the live session map exists.
export function saveSessionMetadataRaw(metadata) {
  try {
    const dir = path.dirname(SESSION_METADATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_METADATA_FILE, JSON.stringify(metadata, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️  Failed to save session metadata:", error.message);
  }
}

export function saveSessionMetadata(sessions) {
  try {
    const metadata = {};
    for (const [id, session] of sessions) {
      metadata[id] = buildSessionMetadata(session, id);
    }
    const dir = path.dirname(SESSION_METADATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_METADATA_FILE, JSON.stringify(metadata, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️  Failed to save session metadata:", error.message);
  }
}

// ============================================
// Terminal groups persistence (agent-managed)
// ============================================

// Returns { groups: [{id,name,createdAt}], sessionGroups: { sessionId: groupId }, sessionOrder: [sessionId] }
export function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8"));
      return { groups: data.groups || [], sessionGroups: data.sessionGroups || {}, sessionOrder: data.sessionOrder || [] };
    }
  } catch (error) {
    console.log("⚠️  Failed to load groups:", error.message);
  }
  return { groups: [], sessionGroups: {}, sessionOrder: [] };
}

export function saveGroups(groups, sessionGroups, sessionOrder = []) {
  try {
    const dir = path.dirname(GROUPS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = { groups: Array.from(groups.values()), sessionGroups, sessionOrder };
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️  Failed to save groups:", error.message);
  }
}

// ============================================
// Terminal workspaces persistence (replaces groups)
// ============================================

// Returns { workspaces: [{id,name,path,createdAt}], sessionWorkspaces: { sessionId: workspaceId }, sessionOrder: [] }
// null when the file is absent → caller runs the group migration instead.
export function loadWorkspaces() {
  try {
    if (!fs.existsSync(WORKSPACES_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf8"));
    return {
      workspaces: data.workspaces || [],
      sessionWorkspaces: data.sessionWorkspaces || {},
      sessionOrder: data.sessionOrder || []
    };
  } catch (error) {
    console.log("⚠️  Failed to load workspaces:", error.message);
    return null;
  }
}

export function saveWorkspaces(workspaces, sessionWorkspaces, sessionOrder = []) {
  try {
    const dir = path.dirname(WORKSPACES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = { workspaces: Array.from(workspaces.values()), sessionWorkspaces, sessionOrder };
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.log("⚠️  Failed to save workspaces:", error.message);
  }
}

const MAX_NOTE_BYTES = 64 * 1024;

// Per-session note (free-form text). Persisted to STATE/notes/<id>.json, survives restarts.
function notePath(sessionId) {
  return path.join(NOTES_DIR, `${sessionId}.json`);
}

export function loadSessionNote(sessionId) {
  if (!sessionId) return "";
  try {
    const file = notePath(sessionId);
    if (!fs.existsSync(file)) return "";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof data.text === "string" ? data.text : "";
  } catch (error) {
    console.log("⚠️  Failed to load note:", error.message);
    return "";
  }
}

export function saveSessionNote(sessionId, text) {
  if (!sessionId) return false;
  try {
    const value = typeof text === "string" ? text : "";
    // Hard cap: reject oversized payload rather than truncate silently.
    if (Buffer.byteLength(value, "utf8") > MAX_NOTE_BYTES) return false;
    if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(notePath(sessionId), JSON.stringify({ text: value }), "utf8");
    return true;
  } catch (error) {
    console.log("⚠️  Failed to save note:", error.message);
    return false;
  }
}

export function deleteSessionNote(sessionId) {
  if (!sessionId) return;
  try {
    const file = notePath(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    console.log("⚠️  Failed to delete note:", error.message);
  }
}
