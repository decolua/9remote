// AI agent display metadata — brand icon + label per tool key (mirrors agent/lib/constants.js TOOL_LABELS)
export const AGENT_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
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

// Brand SVG available in /public/agents/. Others fall back to a generic icon.
export const AGENT_ICONS = {
  claude: "/agents/claude.svg",
  codex: "/agents/codex.svg",
  gemini: "/agents/gemini.svg",
  opencode: "/agents/opencode.svg",
};
