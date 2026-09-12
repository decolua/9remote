// AI engine registry — config-driven, with OOP for behavior.
//
// One shared DEFAULT_CONFIG holds every default. An engine declares ONLY the
// keys it overrides; the base class merges them. Behavior that genuinely
// differs (task parsing) is a polymorphic method on the engine subclass.
//
// Adding a new AI: subclass AiEngine, pass a `meta` block and an `overrides`
// object with just the differing keys, then register it. Nothing else in the
// app branches on an engine id — consumers read the resolved config.

// ── The one shared default config ──
// Tool name → UI category. Category decides which card component renders.
const DEFAULT_TOOL_MAP = Object.freeze({
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
  Agent: "agent",
  Task: "agent",
  Workflow: "agent",
  SendMessage: "agent",
  WebSearch: "search",
  WebFetch: "search",
  Grep: "search",
  Glob: "search",
});

// Shared permission-mode icons, picked by strictness so every engine's mode list
// reads the same: ask → edit freely → read-only → no gate. Names come from Icon.js.
const PERMISSION_ICONS = Object.freeze({
  ask: "Shield",
  edit: "Pencil",
  readonly: "Eye",
  bypass: "Sparkles",
});

const DEFAULT_PERMISSION_MODES = Object.freeze([
  { id: "default", label: "Default", desc: "Ask before executing commands & editing files", icon: PERMISSION_ICONS.ask },
  { id: "acceptEdits", label: "Accept Edits", desc: "Automatically approve file changes", icon: PERMISSION_ICONS.edit },
  { id: "plan", label: "Plan Mode", desc: "Explore and plan without modifying code", icon: PERMISSION_ICONS.readonly },
  { id: "bypassPermissions", label: "Bypass (YOLO)", desc: "Bypass all confirmation prompts", icon: PERMISSION_ICONS.bypass },
]);

const DEFAULT_MODELS = Object.freeze([
  { id: "ag/gemini-3.8-flash-high", label: "ag/gemini-3.8-flash-high", short: "ag/gemini-3.8-flash-high", desc: "Fast hybrid reasoning custom model" },
  { id: "ag/claude-opus-4-6-thinking", label: "ag/claude-opus-4-6-thinking", short: "ag/claude-opus-4-6-thinking", desc: "Opus deep thinking custom model" },
  { id: "ollama/glm-5.3-flash:cloud", label: "ollama/glm-5.3-flash:cloud", short: "ollama/glm-5.3-flash:cloud", desc: "Sonnet cloud custom model" },
  { id: "glm/glm-5.3", label: "glm/glm-5.3", short: "glm/glm-5.3", desc: "GLM 5.3 custom model" },
  { id: "haiku", label: "Claude Haiku", short: "haiku", desc: "Claude Haiku CLI alias" },
  { id: "sonnet", label: "Claude Sonnet", short: "sonnet", desc: "Claude Sonnet CLI alias" },
  { id: "opus", label: "Claude Opus", short: "opus", desc: "Claude Opus CLI alias" },
]);

const DEFAULT_FEATURES = Object.freeze({
  thinking: true,
  planMode: true,
  tasks: true,
  skills: true,
  mcp: true,
  rewind: true,
});

// Reusable submenu value lists, shared by any engine that exposes the option.
const EFFORT_OPTIONS = Object.freeze([
  { value: "low", label: "low", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning for hard tasks" },
]);

// Codex's communication style (`-c personality=`). "none" leaves the model's own
// instructions untouched; the other two are codex's built-in personas.
export const PERSONALITY_OPTIONS = Object.freeze([
  { value: "pragmatic", label: "Pragmatic", desc: "Concise, task-focused, and direct" },
  { value: "friendly", label: "Friendly", desc: "Warm, collaborative, and helpful" },
  { value: "none", label: "None", desc: "No personality instructions" },
]);

// Codex's persistent goal (its state DB, read back over the app-server).

// Claude's --effort accepts two extra levels beyond the shared three.
const CLAUDE_EFFORT_OPTIONS = Object.freeze([
  ...EFFORT_OPTIONS,
  { value: "xhigh", label: "xhigh", desc: "Extra-high reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
]);

/**
 * Slash commands. `action` decides what picking an entry does:
 *   "send"        → forward the literal command to the CLI (the CLI owns it and
 *                   returns its output as the turn's result)
 *   "clear"       → host-side conversation reset
 *   "modal:<id>"  → open a UI modal (model | mcp | skills | sessions | config | doctor | tasks)
 *   "submenu"     → open a second-level list from `subOptions`, applied as `optionKey`
 *
 * Verified against the real CLIs in headless mode (`claude -p`, `codex exec`,
 * `opencode run`). Some interactive slash commands DO work there and return their
 * output as the turn's result (/compact, /cost, /context, /fast, skills like
 * /init and /simplify) — those use action "send". Others are refused headless
 * (/help answers "isn't available in this environment", /review returns nothing),
 * so they are left out rather than offered as a dead entry.
 */
const DEFAULT_SLASH_COMMANDS = Object.freeze([
  { name: "/clear", description: "Clear conversation context and history", action: "clear" },
  { name: "/model", description: "Select or change active AI model", action: "modal:model" },
  { name: "/mcp", description: "List and manage MCP servers", action: "modal:mcp" },
  { name: "/skills", description: "List available agent skills", action: "modal:skills" },
  { name: "/tasks", description: "View background tasks and checklist", action: "modal:tasks" },
  { name: "/resume", description: "Resume a previous conversation in this project", action: "modal:sessions" },
  { name: "/config", description: "Adjust CLI runtime flags", action: "modal:config" },
  { name: "/doctor", description: "Check the CLI installation and environment", action: "modal:doctor" },
  { name: "/compact", description: "Compact the conversation context", action: "send" },
  { name: "/cost", description: "Show token usage and cost for this session", action: "send" },
  { name: "/context", description: "Show context window usage and loaded files", action: "send" },
  { name: "/effort", description: "Reasoning effort level (--effort)", action: "submenu", optionKey: "effort", subOptions: CLAUDE_EFFORT_OPTIONS },
  { name: "/fast", description: "Toggle fast response mode", action: "send" },
  { name: "/init", description: "Create or update the project guide file", action: "send" },
  { name: "/simplify", description: "Simplify and optimize recently changed code", action: "send" },
]);

/** The single shared default. Engines override only what differs. */
export const DEFAULT_CONFIG = Object.freeze({
  tools: DEFAULT_TOOL_MAP,
  models: DEFAULT_MODELS,
  permissionModes: DEFAULT_PERMISSION_MODES,
  // Permission mode a brand-new session starts in. The host applies it only when it
  // has no snapshot for that session — reopening an old chat keeps the mode it ran with.
  defaultMode: "bypassPermissions",
  features: DEFAULT_FEATURES,
  slashCommands: DEFAULT_SLASH_COMMANDS,
});


const VARIANT_OPTIONS = Object.freeze([
  { value: "minimal", label: "minimal", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
]);

// ── Base class ──

/**
 * One AI CLI backend. Data comes from DEFAULT_CONFIG merged with this engine's
 * `overrides`; behavior is a method a subclass may override.
 */
export class AiEngine {
  /**
   * @param {object} params
   * @param {object} params.meta       Display metadata: {id,label,desc,badge,icon,color}
   * @param {object} [params.ui]       "New tab" entry: {id,label,short}
   * @param {object} [params.overrides] Only the config keys that differ from DEFAULT_CONFIG
   */
  constructor({ meta, ui = null, overrides = {} }) {
    if (!meta?.id) throw new Error("AiEngine requires meta.id");
    this.meta = meta;
    this.ui = ui;
    this.overrides = overrides;
    this._config = null;
  }

  /** Engine id, e.g. "claude". */
  get id() {
    return this.meta.id;
  }

  /**
   * Resolved, memoized config: DEFAULT_CONFIG with this engine's overrides.
   * Object-valued keys (tools, features) merge; list-valued keys (models,
   * permissionModes, slashCommands) are replaced wholesale when overridden.
   */
  get config() {
    if (this._config) return this._config;
    const o = this.overrides;
    this._config = Object.freeze({
      tools: { ...DEFAULT_CONFIG.tools, ...(o.tools || {}) },
      models: o.models || DEFAULT_CONFIG.models,
      permissionModes: o.permissionModes || DEFAULT_CONFIG.permissionModes,
      defaultMode: o.defaultMode || DEFAULT_CONFIG.defaultMode,
      features: { ...DEFAULT_CONFIG.features, ...(o.features || {}) },
      slashCommands: o.slashCommands || DEFAULT_CONFIG.slashCommands,
    });
    return this._config;
  }

  /** UI category for a tool name; unknown tools fall back to "generic". */
  getToolCategory(toolName) {
    // Own-property check: a tool named like an Object.prototype member
    // ("constructor", "toString") must fall back, not resolve to a function.
    const cat = Object.prototype.hasOwnProperty.call(this.config.tools, toolName)
      ? this.config.tools[toolName]
      : null;
    return typeof cat === "string" ? cat : "generic";
  }

  /**
   * Map a tool event into a normalized task shape (or null).
   * Default: no task events — engines that report tasks override this.
   */
  parseTaskEvent(toolName, input, toolCallId, currentTasks = []) {
    return null;
  }

  /** Extract an updated taskId/state from a completed tool result (or null). */
  parseTaskResult(toolName, output, toolCallId) {
    return null;
  }

  /** Shared helper: a tool call that replaces the whole todo list. */
  _parseReplaceAllTodos(input, toolCallId) {
    if (!Array.isArray(input?.todos)) return null;
    return {
      id: toolCallId,
      replaceAll: true,
      todos: input.todos
        .filter((t) => t && String(t.content || "").trim())
        .map((t, i) => ({
          id: `${toolCallId}-${i}`,
          taskId: String(i + 1),
          subject: String(t.content).trim(),
          activeForm: t.activeForm || "",
          status: t.status || "pending",
        })),
    };
  }
}

// ── Concrete engines (only the differences) ──

/** Claude Code CLI — uses DEFAULT_CONFIG as-is; only task parsing differs. */
export class ClaudeEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "claude",
        label: "Claude Code",
        desc: "Anthropic Claude Code CLI (stream-json)",
        badge: "Claude",
        icon: "Bot",
        color: "#d97706",
      },
      ui: { id: "claude-ui", label: "Claude UI", short: "Claude UI" },
      overrides: {},
    });
  }

  parseTaskEvent(toolName, input, toolCallId, currentTasks = []) {
    if (toolName === "TaskCreate" && input?.subject) {
      return {
        id: toolCallId,
        taskId: String(currentTasks.length + 1),
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
    if (toolName === "TodoWrite") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }

  parseTaskResult(toolName, output, toolCallId) {
    if (typeof output !== "string") return null;
    const match = /Task #(\d+) created/i.exec(output);
    return match ? { id: toolCallId, taskId: match[1] } : null;
  }
}

/** OpenAI Codex CLI — sandbox permissions, todo_list task shape. */
export class CodexEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "codex",
        label: "OpenAI Codex",
        desc: "OpenAI Codex CLI (exec --json)",
        badge: "Codex",
        icon: "Sparkles",
        color: "#10b981",
      },
      ui: { id: "codex-ui", label: "Codex UI", short: "Codex UI" },
      overrides: {
        // Codex adapter normalizes JSON item types to these names
        tools: {
          command_execution: "bash",
          file_change: "diff",
          shell: "bash",
          patch: "diff",
          apply: "diff",
          read_file: "file",
          todo_list: "task",
          web_search: "search",
          // Codex's sub-agents (collab_tool_call). `wait` is antigravity's own tool name
          // too, so it is scoped here rather than in the shared defaults.
          spawn_agent: "agent",
          wait: "agent",
          resume_agent: "agent",
          send_input: "agent",
          close_agent: "agent",
        },
        // Model ids and their supported reasoning tiers come from the host's own codex
        // catalog (`modelOptions` in the init event); these are only the fallback for a
        // host whose catalog could not be read.
        models: [
          { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", short: "5.6 Luna" },
          { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", short: "5.6 Sol" },
          { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", short: "5.6 Terra" },
          { id: "gpt-5.5", label: "GPT-5.5", short: "5.5" },
          { id: "gpt-5.2", label: "GPT-5.2", short: "5.2" },
        ],
        // Codex's own permission presets (the TUI's Read Only / Default / Full Access),
        // plus Plan — a separate axis in the CLI (collaboration_mode) that proposes
        // instead of executing. Its sandbox and approval policy are the adapter's.
        permissionModes: [
          { id: "plan", label: "Plan", desc: "Explore and propose without changing anything", icon: PERMISSION_ICONS.readonly },
          { id: "readOnly", label: "Read Only", desc: "Read the workspace; ask before editing", icon: PERMISSION_ICONS.ask },
          { id: "default", label: "Default", desc: "Read and write the workspace", icon: PERMISSION_ICONS.edit },
          { id: "fullAccess", label: "Full Access", desc: "Edit anywhere and reach the network, no prompts", icon: PERMISSION_ICONS.bypass },
        ],
        defaultMode: "default",
        features: { thinking: true, planMode: true, tasks: true, skills: true, mcp: true, rewind: true },
        slashCommands: [
          { name: "/model", description: "Choose the Codex model and reasoning effort", action: "modal:model" },
          { name: "/plan", description: "Switch the session into plan mode", action: "setMode", mode: "plan" },
          { name: "/permissions", description: "Set what Codex may do without asking", action: "modal:mode" },
          { name: "/personality", description: "Assistant communication style", action: "submenu", optionKey: "personality", subOptions: PERSONALITY_OPTIONS },
          { name: "/diff", description: "Show the working tree diff", action: "send" },
          { name: "/review", description: "Review the working tree for bugs and missing tests", action: "send" },
          { name: "/status", description: "Show workspace status and configuration", action: "send" },
          { name: "/clear", description: "Start a fresh Codex session", action: "clear" },
          { name: "/mcp", description: "View and manage Codex MCP servers", action: "modal:mcp" },
          { name: "/skills", description: "Browse installed Codex skills", action: "modal:skills" },
          { name: "/config", description: "Configure Codex execution flags", action: "modal:config" },
          { name: "/doctor", description: "Diagnose the Codex installation", action: "modal:doctor" },
          { name: "/tasks", description: "View the task checklist", action: "modal:tasks" },
          { name: "/resume", description: "Resume a previous Codex session", action: "modal:sessions" },
        ],
      },
    });
  }

  parseTaskEvent(toolName, input, toolCallId) {
    if (toolName === "todo_list") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }
}

/** OpenCode CLI — auto-approve permissions, todowrite task shape. */
export class OpenCodeEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "opencode",
        label: "OpenCode",
        desc: "OpenCode CLI (json stream)",
        badge: "OpenCode",
        icon: "Zap",
        color: "#8b5cf6",
      },
      overrides: {
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
        permissionModes: [
          { id: "default", label: "Default", desc: "Ask before executing", icon: PERMISSION_ICONS.ask },
          { id: "auto", label: "Auto", desc: "Auto-approve all actions", icon: PERMISSION_ICONS.bypass },
        ],
        defaultMode: "auto",
        features: { thinking: true, planMode: false, tasks: false, skills: false, mcp: false, rewind: true },
        slashCommands: [
          { name: "/model", description: "Choose the OpenCode model", action: "modal:model" },
          { name: "/variant", description: "Model variant / reasoning effort", action: "submenu", optionKey: "variant", subOptions: VARIANT_OPTIONS },
          { name: "/mcp", description: "View and manage OpenCode MCP servers", action: "modal:mcp" },
          { name: "/resume", description: "Resume a previous OpenCode session", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh OpenCode session", action: "clear" },
          // Verified: `opencode run "/help"` answers with its own help text.
          { name: "/help", description: "Show OpenCode help and usage", action: "send" },
          { name: "/doctor", description: "Check the OpenCode installation", action: "modal:doctor" },
          { name: "/tasks", description: "View the task checklist", action: "modal:tasks" },
        ],
      },
    });
  }

  parseTaskEvent(toolName, input, toolCallId) {
    if (toolName === "todowrite") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }
}

/** Antigravity CLI (`agy`) — stream-json steps, no separate effort flag. */
export class AntigravityEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "antigravity",
        label: "Antigravity",
        desc: "Google Antigravity CLI (agy, stream-json)",
        badge: "Antigravity",
        icon: "Globe",
        color: "#4285f4",
      },
      overrides: {
        // `agy` tool names, as reported in step_update.tool_name.
        tools: {
          run_command: "bash",
          command_status: "bash",
          send_command_input: "bash",
          view_file: "file",
          list_dir: "file",
          read_resource: "file",
          write_to_file: "diff",
          replace_file_content: "diff",
          multi_replace_file_content: "diff",
          sed_file: "diff",
          notebook_edit: "diff",
          notebook_execution: "diff",
          find_by_name: "search",
          grep_search: "search",
          search_web: "search",
          read_url_content: "search",
          open_browser_url: "search",
          browser_get_dom: "search",
          browser_get_network_request: "search",
          browser_list_network_requests: "search",
          browser_refresh_page: "search",
          browser_subagent: "agent",
          invoke_subagent: "agent",
          define_subagent: "agent",
          manage_subagents: "agent",
          manage_task: "task",
          manage_inbox: "task",
          schedule: "task",
          ask_question: "question",
          ask_permission: "question",
          ask_custom_permission: "question",
          call_mcp_tool: "generic",
          generate_image: "generic",
          execute_browser_javascript: "generic",
          browser_click_element: "generic",
          browser_input: "generic",
          browser_press_key: "generic",
          browser_scroll: "generic",
          browser_scroll_dom: "generic",
          browser_select_option: "generic",
          browser_resize_window: "generic",
          browser_move_mouse: "generic",
          browser_mouse_down: "generic",
          browser_mouse_up: "generic",
          browser_drag_pixel_to_pixel: "generic",
          click_browser_pixel: "generic",
          capture_browser_screenshot: "generic",
          capture_browser_console_logs: "generic",
          list_browser_pages: "generic",
          read_browser_page: "generic",
          delete_knowledge: "generic",
          list_permissions: "generic",
          list_resources: "generic",
          wait: "generic",
          wait_5_seconds: "generic",
          send_message: "generic",
          finish: "generic",
        },
        // The model id already carries its reasoning tier (gemini-3.8-flash-low), so
        // there is no separate effort flag — the CLI rejects the combination.
        models: [
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", short: "3.8 Flash H" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", short: "3.8 Flash M" },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", short: "3.8 Flash L" },
          { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", short: "3.7 Flash H" },
          { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)", short: "3.7 Flash M" },
          { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)", short: "3.7 Flash L" },
          { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)", short: "3.6 Flash H" },
          { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)", short: "3.6 Flash M" },
          { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)", short: "3.6 Flash L" },
          { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)", short: "3.1 Pro H" },
          { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", short: "3.1 Pro L" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", short: "Sonnet 4.6" },
          { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", short: "Opus 4.6" },
          { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", short: "GPT-OSS 120B" },
        ],
        // Headless mode cannot raise a permission prompt, so only the two extremes
        // exist: the CLI's own read-only plan mode, or bypassing the gate entirely.
        permissionModes: [
          { id: "plan", label: "Plan", desc: "Explore and plan without modifying code", icon: PERMISSION_ICONS.readonly },
          { id: "accept-edits", label: "Accept Edits", desc: "Auto-approve every tool the agent calls", icon: PERMISSION_ICONS.edit },
        ],
        defaultMode: "accept-edits",
        features: { thinking: true, planMode: true, tasks: false, skills: false, mcp: false, rewind: false },
        slashCommands: [
          { name: "/model", description: "Choose the Antigravity model", action: "modal:model" },
          { name: "/resume", description: "Resume a previous Antigravity conversation", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh Antigravity conversation", action: "clear" },
          { name: "/doctor", description: "Check the Antigravity CLI installation", action: "modal:doctor" },
          { name: "/plan", description: "Switch the session into read-only plan mode", action: "send" },
        ],
      },
    });
  }
}

// ── Registry ──

export const DEFAULT_ENGINE_ID = "claude";

/** @type {Map<string, AiEngine>} insertion order = menu order */
const registry = new Map();

/** Register an engine. A later registration with the same id replaces the earlier one. */
export function registerEngine(engine) {
  if (!(engine instanceof AiEngine)) throw new Error("registerEngine expects an AiEngine");
  registry.set(engine.id, engine);
  return engine;
}

/** Look up an engine by id, falling back to the default. */
export function getEngine(engineId) {
  return registry.get(engineId) || registry.get(DEFAULT_ENGINE_ID);
}

/** All registered engines, in registration order. */
export function listEngineInstances() {
  return [...registry.values()];
}

// Built-in engines.
registerEngine(new ClaudeEngine());
registerEngine(new CodexEngine());
registerEngine(new OpenCodeEngine());
registerEngine(new AntigravityEngine());

// ── Function-style API (thin wrappers over the registry) ──

/** Resolved config for an engine. */
export function getEngineConfig(engineId = DEFAULT_ENGINE_ID) {
  return getEngine(engineId).config;
}

/** Display metadata for an engine (label, icon, color, badge). */
export function getEngineInfo(engineId = DEFAULT_ENGINE_ID) {
  return getEngine(engineId).meta;
}

/** Engines as a list of display metadata, for menus and pickers. */
export function listEngines() {
  return listEngineInstances().map((e) => e.meta);
}

/** "New tab" entries for the AI UIs, derived from the engine descriptors.
 *  Engines with no `ui` block expose no chat-UI tab (temporarily hidden). */
export function listAiUiOptions() {
  return listEngineInstances().filter((e) => e.ui).map((e) => ({ ...e.ui, isAiUi: true, aiEngine: e.id }));
}

/** UI category for a tool name. */
export function getToolCategory(engineId, toolName) {
  return getEngine(engineId).getToolCategory(toolName);
}

/** Map an engine-specific tool event into a normalized task shape. */
export function parseEngineTaskEvent(engineId, toolName, input, toolCallId, currentTasks = []) {
  return getEngine(engineId).parseTaskEvent(toolName, input, toolCallId, currentTasks);
}

/** Extract an updated taskId/state from a completed tool result. */
export function parseEngineTaskResult(engineId, toolName, output, toolCallId) {
  return getEngine(engineId).parseTaskResult(toolName, output, toolCallId);
}
