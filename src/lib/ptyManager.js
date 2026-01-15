import { spawn } from "node-pty";

const sessions = new Map();

/**
 * Create PTY session
 * @param {string} sessionId
 * @param {number} cols
 * @param {number} rows
 * @returns {IPty}
 */
export function createSession(sessionId, cols = 80, rows = 24) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }
  
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
  
  const pty = spawn(shell, [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: process.env.HOME || process.cwd(),
    env: process.env
  });
  
  sessions.set(sessionId, pty);
  
  pty.onExit(() => {
    sessions.delete(sessionId);
  });
  
  return pty;
}

/**
 * Get existing session
 * @param {string} sessionId
 * @returns {IPty | null}
 */
export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Delete session
 * @param {string} sessionId
 */
export function deleteSession(sessionId) {
  const pty = sessions.get(sessionId);
  if (pty) {
    pty.kill();
    sessions.delete(sessionId);
  }
}

/**
 * Resize session
 * @param {string} sessionId
 * @param {number} cols
 * @param {number} rows
 */
export function resizeSession(sessionId, cols, rows) {
  const pty = sessions.get(sessionId);
  if (pty) {
    pty.resize(cols, rows);
  }
}
