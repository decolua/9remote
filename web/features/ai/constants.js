// AI Feature constants for 9remote
// ponytail: engine-specific config (models, modes, tools) lives in registry.js — upgrade path: add engine there

export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode"
};

export const ENGINE_INFO = {
  claude: {
    id: "claude",
    label: "Claude Code",
    desc: "Anthropic Claude Code CLI (stream-json)",
    badge: "Claude",
    icon: "Bot",
    color: "#d97706",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex",
    desc: "OpenAI Codex CLI (exec --json)",
    badge: "Codex",
    icon: "Sparkles",
    color: "#10b981",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    desc: "OpenCode CLI (json stream)",
    badge: "OpenCode",
    icon: "Zap",
    color: "#8b5cf6",
  }
};

export const AI_UI_OPTIONS = [
  { id: "claude-ui", label: "Claude Code (UI)", short: "Claude UI", isAiUi: true, aiEngine: "claude" },
  { id: "codex-ui", label: "OpenAI Codex (UI)", short: "Codex UI", isAiUi: true, aiEngine: "codex" },
  { id: "opencode-ui", label: "OpenCode (UI)", short: "OpenCode UI", isAiUi: true, aiEngine: "opencode" },
];

// Re-export for backward compat — canonical source is registry.js
export { getEngineConfig } from "./registry.js";
export const SLASH_COMMANDS = [
  { name: "/clear", description: "Clear conversation context and history" },
  { name: "/compact", description: "Compact conversation context summary" },
  { name: "/cost", description: "Show token usage and cost metrics" },
  { name: "/context", description: "Show context window size and loaded files" },
  { name: "/doctor", description: "Check agent system health and environment" },
  { name: "/help", description: "Show help and available commands" },
  { name: "/model", description: "Select or change active AI model" },
  { name: "/mcp", description: "List and manage MCP servers" },
  { name: "/skills", description: "List available agent skills" }
];
