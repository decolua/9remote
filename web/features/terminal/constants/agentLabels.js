import { agentIconUrl } from "./agentCli";

// AI agent display metadata — brand icon + label per tool key (mirrors agent/lib/constants.js TOOL_LABELS)
export const AGENT_LABELS = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  cursor: "Cursor",
  antigravity: "Antigravity",
  kiro: "Kiro",
  copilot: "Copilot",
  codebuddy: "CodeBuddy",
  factory: "Factory",
  qoder: "Qoder",
  rovodev: "Rovo Dev",
  hermes: "Hermes",
  amp: "Amp",
  pi: "Pi",
  "qwen-code": "Qwen",
  droid: "Droid",
  crush: "Crush",
};

// Brand icons in /public/agent-icons/ covering all 35+ supported CLIs.
export const AGENT_ICONS = new Proxy({}, {
  get: (_, tool) => (typeof tool === "string" && tool ? agentIconUrl(tool) || undefined : undefined)
});
