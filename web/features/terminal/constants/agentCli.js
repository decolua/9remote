// Bundled agent CLI icons in web/public/agent-icons. Most are PNG favicons; the
// few below ship as hand-authored SVG because upstream has no usable favicon.
const SVG_ICON_IDS = new Set(["claude", "codex", "aider", "pi", "omp"]);

export const AGENT_ICON_BASE = "/agent-icons";

export function agentIconUrl(agentId) {
  if (!agentId) return null;
  return `${AGENT_ICON_BASE}/${agentId}.${SVG_ICON_IDS.has(agentId) ? "svg" : "png"}`;
}

// True when the agent exposes a way to run without per-action approval prompts
export function canSkipPermissions(agent) {
  return !!(agent?.yolo || agent?.yoloEnv);
}

// Shell command that launches the agent, optionally in skip-permission mode.
// yoloEnv agents get a `VAR=value cmd` prefix (the agent only sends yoloEnv on POSIX hosts).
export function agentLaunchCommand(agent, skipPermissions = false) {
  if (!agent?.cmd) return null;
  if (!skipPermissions) return agent.cmd;
  if (agent.yolo) return `${agent.cmd} ${agent.yolo}`;
  if (agent.yoloEnv) {
    const prefix = Object.entries(agent.yoloEnv).map(([k, v]) => `${k}=${v}`).join(" ");
    return `${prefix} ${agent.cmd}`;
  }
  return agent.cmd;
}

// Re-apply the agent's own skip-permission mode to an already-built command line
// (a resume line). Same tokens as agentLaunchCommand: flag appended, env prefixed.
export function applySkipPermissions(agent, line) {
  if (!agent || !line) return line;
  if (agent.yolo) return `${line} ${agent.yolo}`;
  if (agent.yoloEnv) {
    const prefix = Object.entries(agent.yoloEnv).map(([k, v]) => `${k}=${v}`).join(" ");
    return `${prefix} ${line}`;
  }
  return line;
}

// Last-used new-terminal choices, shared by the modal (which writes them) and the
// Mod+Shift+Enter chord (which replays them without opening the modal).
const SHELL_PREF_KEY = "9remote.terminal.shellPref";
const AGENT_PREF_KEY = "9remote.terminal.agentPref";
// v2: default flipped to on — a new key so an old opt-out value isn't read as one
const YOLO_PREF_KEY = "9remote.terminal.yoloPref2";

function loadPref(key) {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}

export function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export const TERMINAL_PREF_KEYS = { shell: SHELL_PREF_KEY, agent: AGENT_PREF_KEY, yolo: YOLO_PREF_KEY };

export function loadShellPref() {
  return loadPref(SHELL_PREF_KEY);
}

// yolo defaults to on, matching the modal's opt-out toggle.
export function loadTerminalPrefs() {
  return {
    agentId: loadPref(AGENT_PREF_KEY) || "",
    shellId: loadPref(SHELL_PREF_KEY),
    yolo: loadPref(YOLO_PREF_KEY) !== "0"
  };
}
