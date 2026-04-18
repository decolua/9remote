/**
 * Command Notes Constants
 */

export const COMMAND_NOTES_CONFIG = {
  storageKey: "9remote_command_notes_v2",
  maxNotes: 50
};

// Default popular commands (created if localStorage is empty)
export const DEFAULT_COMMAND_NOTES = [
  { command: "npm i 9router -g" },
  { command: "curl -fsSL https://claude.ai/install.sh | bash" },
  { command: "npm i -g @openai/codex" },
  { command: "curl -fsSL https://opencode.ai/install | bash" },
];
