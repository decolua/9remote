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
