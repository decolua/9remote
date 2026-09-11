// Constants for AI Features in 9remote

export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode"
};

export const AI_SOCKET_EVENTS = {
  CREATE: "ai:create",
  PROMPT: "ai:prompt",
  PERMISSION: "ai:permission",
  QUESTION: "ai:question",
  STOP: "ai:stop",
  RESET: "ai:reset",
  OPTIONS: "ai:options",
  DESTROY: "ai:destroy",
  LIST: "ai:list",
  EVENT: "ai:event"
};

// How long a codex/opencode turn may go silent before it is treated as hung. Both CLIs
// occasionally stall on startup (provider hiccup, prompt cache miss) and then never
// emit anything — without this the turn stays "running" forever and the chat shows no
// reply and no error. Claude is excluded: its PTY daemon owns that lifecycle instead.
export const AI_TURN_IDLE_TIMEOUT_MS = 120000;

// How long a `/doctor` health check may run before it is killed.
export const AI_DOCTOR_TIMEOUT_MS = 30000;
