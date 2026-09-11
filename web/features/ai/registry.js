// AI engine registry — base config + per-engine overrides.
// Adding a new AI = add an entry to ENGINE_OVERRIDES with only what differs.

// ── Tool category mapping ──
// Maps tool names to UI categories. Category determines which card component renders.
// Unknown tools fall back to "generic".
const BASE_TOOL_MAP = {
  Bash: "bash",
  BashOutput: "bash", // reads a background shell's output
  KillShell: "bash",
  Edit: "diff",
  Write: "diff",
  MultiEdit: "diff",
  NotebookEdit: "diff",
  Read: "file",
  NotebookRead: "file",
  TaskCreate: "task",
  TaskUpdate: "task",
  TaskList: "task",
  TaskGet: "task",
  TaskOutput: "task",
  TaskStop: "task",
  TodoWrite: "task",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan",
  AskUserQuestion: "question",
  // Agent/subagent tools
  Agent: "agent",
  Task: "agent",
  Workflow: "agent",
  SendMessage: "agent",
  // Search / web — generic row is fine, but tagged for future
  WebSearch: "search",
  WebFetch: "search",
  Grep: "search",
  Glob: "search",
  // Everything else → "generic" (handled by fallback)
};

// ── Permission modes ──
const BASE_PERMISSION_MODES = [
  { id: "default", label: "Default", desc: "Ask before executing commands & editing files" },
  { id: "acceptEdits", label: "Accept Edits", desc: "Automatically approve file changes" },
  { id: "plan", label: "Plan Mode", desc: "Explore and plan without modifying code" },
  { id: "bypassPermissions", label: "Bypass (YOLO)", desc: "Bypass all confirmation prompts" },
];

// ── Models ──
const BASE_MODELS = [
  { id: "ag/gemini-3.8-flash-high", label: "ag/gemini-3.8-flash-high", short: "ag/gemini-3.8-flash-high", desc: "Fast hybrid reasoning custom model" },
  { id: "ag/claude-opus-4-6-thinking", label: "ag/claude-opus-4-6-thinking", short: "ag/claude-opus-4-6-thinking", desc: "Opus deep thinking custom model" },
  { id: "ollama/glm-5.3-flash:cloud", label: "ollama/glm-5.3-flash:cloud", short: "ollama/glm-5.3-flash:cloud", desc: "Sonnet cloud custom model" },
  { id: "glm/glm-5.3", label: "glm/glm-5.3", short: "glm/glm-5.3", desc: "GLM 5.3 custom model" },
  { id: "haiku", label: "Claude Haiku", short: "haiku", desc: "Claude Haiku CLI alias" },
  { id: "sonnet", label: "Claude Sonnet", short: "sonnet", desc: "Claude Sonnet CLI alias" },
  { id: "opus", label: "Claude Opus", short: "opus", desc: "Claude Opus CLI alias" },
];

// ── Feature flags ──
const BASE_FEATURES = {
  thinking: true,
  planMode: true,
  tasks: true,
  skills: true,
  mcp: true,
  rewind: true,
};

// ── Slash commands ──
const BASE_SLASH_COMMANDS = [
  { name: "/clear", description: "Clear conversation context and history" },
  { name: "/compact", description: "Compact conversation context summary" },
  { name: "/cost", description: "Show token usage and cost metrics" },
  { name: "/context", description: "Show context window size and loaded files" },
  { name: "/doctor", description: "Check agent system health and environment" },
  { name: "/help", description: "Show help and available commands" },
  { name: "/model", description: "Select or change active AI model" },
  { name: "/mcp", description: "List and manage MCP servers" },
  { name: "/skills", description: "List available agent skills" },
];

// ── Base config (shared by all engines) ──
const BASE_CONFIG = {
  tools: BASE_TOOL_MAP,
  permissionModes: BASE_PERMISSION_MODES,
  models: BASE_MODELS,
  features: BASE_FEATURES,
  slashCommands: BASE_SLASH_COMMANDS,
};

// ── Per-engine overrides (only what differs) ──
const ENGINE_OVERRIDES = {
  claude: {
    // Claude uses base config as-is
  },
  codex: {
    tools: {
      // Codex adapter normalizes JSON item types to these names
      command_execution: "bash",
      file_change: "diff",
      // Legacy/mock item names
      shell: "bash",
      patch: "diff",
      apply: "diff",
      read_file: "file",
      todo_list: "task",
      web_search: "search",
    },
    models: [
      { id: "o3", label: "o3", short: "o3" },
      { id: "o4-mini", label: "o4-mini", short: "o4-mini" },
      { id: "gpt-4.1", label: "GPT-4.1", short: "GPT-4.1" },
    ],
    features: { thinking: false, planMode: false, tasks: false, skills: false, mcp: false, rewind: true },
    permissionModes: [
      { id: "suggest", label: "Suggest", desc: "Suggest changes without applying" },
      { id: "autoEdit", label: "Auto Edit", desc: "Automatically apply file edits" },
      { id: "fullAuto", label: "Full Auto", desc: "Execute all actions without confirmation" },
    ],
    slashCommands: [
      { name: "/clear", description: "Clear conversation" },
      { name: "/help", description: "Show help" },
    ],
  },
  opencode: {
    tools: {
      bash: "bash",
      edit: "diff",
      write: "diff",
      patch: "diff",
      read: "file",
      task: "agent",
      todowrite: "task",
      webfetch: "search",
      glob: "search",
      grep: "search",
      list: "search",
      view: "file",
    },
    models: [
      { id: "claude-3-7-sonnet-latest", label: "Sonnet 3.7", short: "Sonnet 3.7" },
      { id: "gpt-4o", label: "GPT-4o", short: "GPT-4o" },
    ],
    features: { thinking: true, planMode: false, tasks: false, skills: false, mcp: false, rewind: true },
    permissionModes: [
      { id: "default", label: "Default", desc: "Ask before executing" },
      { id: "auto", label: "Auto", desc: "Auto-approve all actions" },
    ],
    slashCommands: [
      { name: "/clear", description: "Clear conversation" },
      { name: "/compact", description: "Compact context" },
      { name: "/help", description: "Show help" },
    ],
  },
};

// ── Resolved config cache ──
const _cache = {};

/**
 * Get resolved config for an engine. Merges base + overrides.
 * @param {string} engine - "claude" | "codex" | "opencode"
 */
export function getEngineConfig(engine = "claude") {
  if (_cache[engine]) return _cache[engine];

  const overrides = ENGINE_OVERRIDES[engine] || {};

  const config = {
    // Tools: merge base + engine-specific (engine tools override base for same name)
    tools: { ...BASE_CONFIG.tools, ...(overrides.tools || {}) },
    // Arrays: override replaces entirely (models, modes, commands are engine-specific sets)
    permissionModes: overrides.permissionModes || BASE_CONFIG.permissionModes,
    models: overrides.models || BASE_CONFIG.models,
    features: overrides.features ? { ...BASE_CONFIG.features, ...overrides.features } : { ...BASE_CONFIG.features },
    slashCommands: overrides.slashCommands || BASE_CONFIG.slashCommands,
  };

  _cache[engine] = config;
  return config;
}

/**
 * Get tool category for rendering.
 * @returns {"bash"|"diff"|"file"|"task"|"plan"|"question"|"agent"|"search"|"generic"}
 */
export function getToolCategory(engine, toolName) {
  const config = getEngineConfig(engine);
  return config.tools[toolName] || "generic";
}

/**
 * Pluggable task event parser per AI engine.
 * Maps engine-specific tool events into a normalized task shape.
 */
export function parseEngineTaskEvent(engine, toolName, input, toolCallId, currentTasks = []) {
  if (engine === "claude") {
    if (toolName === "TaskCreate" && input && input.subject) {
      const nextSeq = String(currentTasks.length + 1);
      return {
        id: toolCallId,
        taskId: nextSeq,
        subject: String(input.subject).trim(),
        activeForm: input.activeForm || "",
        status: "pending",
      };
    }
    if (toolName === "TaskUpdate" && input) {
      return {
        id: toolCallId,
        taskId: input.taskId ? String(input.taskId) : "",
        ...(input.status && { status: input.status }),
        ...(input.subject && { subject: String(input.subject).trim() }),
        ...(input.activeForm && { activeForm: input.activeForm }),
      };
    }
    // TodoWrite replaces the whole list — one event carrying every item
    if (toolName === "TodoWrite" && Array.isArray(input?.todos)) {
      return { id: toolCallId, replaceAll: true, todos: todoListToTasks(toolCallId, input.todos) };
    }
  }

  if (engine === "opencode" && toolName === "todowrite" && Array.isArray(input?.todos)) {
    return { id: toolCallId, replaceAll: true, todos: todoListToTasks(toolCallId, input.todos) };
  }

  if (engine === "codex" && toolName === "todo_list" && Array.isArray(input?.todos)) {
    return { id: toolCallId, replaceAll: true, todos: todoListToTasks(toolCallId, input.todos) };
  }

  // Future engine extensions: add codex / opencode / custom agent task formats here
  return null;
}

function todoListToTasks(toolCallId, todos) {
  return todos
    .filter((t) => t && String(t.content || "").trim())
    .map((t, i) => ({
      id: `${toolCallId}-${i}`,
      taskId: String(i + 1),
      subject: String(t.content).trim(),
      activeForm: t.activeForm || "",
      status: t.status || "pending",
    }));
}

/**
 * Pluggable task result parser per AI engine.
 * Extracts updated taskId or state from completed tool results.
 */
export function parseEngineTaskResult(engine, toolName, output, toolCallId) {
  if (engine === "claude" && output && typeof output === "string") {
    const match = /Task #(\d+) created/i.exec(output);
    if (match) {
      return { id: toolCallId, taskId: match[1] };
    }
  }
  return null;
}
