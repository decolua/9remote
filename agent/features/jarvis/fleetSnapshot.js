// How Jarvis sees every open session without reading a single raw terminal byte.
// PTY facts come from the daemon's listSessions, AI state (turn/gate) overlays the
// matching row, and branch/worktree facts ride in from a git probe the caller owns.
//
// Status precedence: a waiting gate outranks a running turn — the conductor's next
// move is to read the ask aloud, so needs_input must win even mid-turn.

// A foreground process basename → the engine id the registry knows.
const FOREGROUND_ENGINES = new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["aider", "aider"]
]);

/**
 * Build the fleet rows.
 *   ptySessions      — daemon listSessions() shape: { id, name, cwd, workspacePath?, foregroundProcess }
 *   aiSessions       — aiManager rows with gate/turn facts: { id, engine, cwd, isTurnRunning, activePermission, lastPrompt }
 *   branches         — optional { [sessionId]: branchName }
 *   worktrees        — optional { [sessionId]: true }
 */
export function buildFleetSnapshot({ ptySessions = [], aiSessions = [], branches = {}, worktrees = {}, workspacePaths = {} }) {
  const aiById = new Map(aiSessions.filter((s) => s && s.id).map((s) => [s.id, s]));

  const rows = [];
  const seen = new Set();
  for (const pty of ptySessions) {
    if (!pty?.id) continue;
    seen.add(pty.id);
    rows.push(rowFor(pty.id, pty, aiById.get(pty.id), branches[pty.id] || null, !!worktrees[pty.id], workspacePaths[pty.id] || null));
  }
  // A headless AI pane (a chat with no terminal behind it) still counts as crew.
  for (const ai of aiSessions) {
    if (!ai?.id || seen.has(ai.id)) continue;
    rows.push(rowFor(ai.id, null, ai, branches[ai.id] || null, !!worktrees[ai.id], workspacePaths[ai.id] || null));
  }
  return rows;
}

function rowFor(id, pty, ai, branch, isWorktree, workspacePath) {
  const engine = ai?.engine
    || FOREGROUND_ENGINES.get(String(pty?.foregroundProcess || "").toLowerCase())
    || "bash";

  let status = "idle";
  let question = null;
  if (ai) {
    if (ai.activePermission) {
      status = "needs_input";
      question = gateQuestion(ai.activePermission);
    } else if (ai.isTurnRunning) {
      status = "running";
    }
  }

  return {
    sessionId: id,
    title: pty?.name || null,
    engine,
    cwd: pty?.cwd || ai?.cwd || null,
    branch,
    isWorktree,
    workspacePath,
    status,
    question,
    lastPrompt: ai?.lastPrompt || null
  };
}

// The ask a gate carries, flattened to one line Jarvis can read aloud.
function gateQuestion(gate) {
  if (!gate || typeof gate !== "object") return "Session is waiting for input";
  const parts = [gate.tool, gate.reason || gate.message].filter(Boolean);
  return parts.join(": ") || "Session is waiting for input";
}
