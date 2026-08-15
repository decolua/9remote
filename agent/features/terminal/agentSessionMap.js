// Maps a 9Remote terminal session (pane) to the AI CLI session running inside it.
// Fed by hook payloads: the CLI stamps NINE_REMOTE_SESSION_ID into its env, so every hook
// it fires is attributable to the pane without guessing from cwd.
//
// Persisted next to sessions.json so a mapping survives an agent restart (the PTY does).
import fs from "fs";
import path from "path";
import { PATHS } from "../../lib/constants.js";

const FILE_NAME = "agentSessions.json";

let stateDir = PATHS.STATE;
let cache = null;

const filePath = () => path.join(stateDir, FILE_NAME);

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (!cache || typeof cache !== "object") cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Mapping is a convenience layer — a failed write must never break the hook path.
  }
}

// The CLI has finished; the next arrival is a genuinely new run, not a nested child.
const RELEASE_EVENTS = new Set(["SessionEnd", "SessionExit"]);

/** Record one hook event against a pane. Returns the resulting mapping, or null if unusable. */
export function recordHookEvent({ sessionId, tool, event, launchToken, payload } = {}) {
  if (!sessionId) return null;
  const map = load();
  const prev = map[sessionId];

  // Nested agents inherit the parent's env — a foreign token must not overwrite the pane.
  if (!isLaunchTokenCurrent(sessionId, launchToken)) return prev || null;

  const providerSessionId = payload?.session_id || null;

  // A subagent or a nested `claude` call inherits NINE_REMOTE_SESSION_ID, so its hooks are
  // indistinguishable from the pane's own except for the provider session id they report.
  // Whoever claimed the pane keeps it until that CLI actually ends.
  if (prev?.providerSessionId && providerSessionId && providerSessionId !== prev.providerSessionId && !prev.released) {
    return prev;
  }

  // A different provider session on a released pane = a fresh CLI run: start the mapping over.
  const isNewRun = !prev || (providerSessionId && providerSessionId !== prev.providerSessionId);
  const base = isNewRun ? {} : prev;

  const entry = {
    tool: tool || base.tool || null,
    providerSessionId: providerSessionId || base.providerSessionId || null,
    // Take transcript_path verbatim — recent Claude names the JSONL with a UUID that
    // differs from session_id, so reconstructing the path from the id fails.
    transcriptPath: payload?.transcript_path || base.transcriptPath || null,
    // `claude --resume` resolves the project dir from the CURRENT cwd, so pin the cwd we
    // first saw; a mid-session `cd` would otherwise break resume with "No conversation found".
    startCwd: base.startCwd || payload?.cwd || null,
    launchToken: launchToken || base.launchToken || null,
    lastEvent: event || base.lastEvent || null,
    // Released panes accept a new owner. Stop is NOT a release — it ends a turn, and the
    // same CLI keeps running and will fire more hooks.
    released: RELEASE_EVENTS.has(event),
    updatedAt: Date.now(),
  };

  map[sessionId] = entry;
  persist();
  return entry;
}

export function getMapping(sessionId) {
  if (!sessionId) return null;
  return load()[sessionId] || null;
}

export function getAllMappings() {
  return { ...load() };
}

export function clearMapping(sessionId) {
  if (!sessionId) return;
  const map = load();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  persist();
}

/** True when `token` belongs to the CLI that owns this pane (or nothing is claimed yet). */
export function isLaunchTokenCurrent(sessionId, token) {
  const known = load()[sessionId]?.launchToken;
  if (!known) return true;   // nothing claimed, or a legacy hook with no token
  if (!token) return true;   // caller sent no token — cannot disprove ownership, fail open
  return known === token;
}

/* ---- test seams ---- */
export function _resetForTest() { cache = null; }
export function _fileForTest() { return filePath(); }
export function _setDirForTest(dir) { stateDir = dir; cache = null; }
