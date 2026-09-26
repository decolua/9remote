// AI engine registry: base config with engine overrides.
const DEFAULT_TOOL_MAP = Object.freeze({
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Monitor: "bash",
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
  update_plan: "plan",
  enteredReviewMode: "review",
  exitedReviewMode: "review",
  // Rollout replays use PascalCase item types
  EnteredReviewMode: "review",
  ExitedReviewMode: "review",
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

// Normalize engine status naming (Codex inProgress vs Claude in_progress)
const TODO_STATUS = Object.freeze({
  inProgress: "in_progress",
  in_progress: "in_progress",
  pending: "pending",
  completed: "completed",
});

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

const EFFORT_OPTIONS = Object.freeze([
  { value: "low", label: "low", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning for hard tasks" },
]);

// Codex communication style personas
export const PERSONALITY_OPTIONS = Object.freeze([
  { value: "pragmatic", label: "Pragmatic", desc: "Concise, task-focused, and direct" },
  { value: "friendly", label: "Friendly", desc: "Warm, collaborative, and helpful" },
  { value: "none", label: "None", desc: "No personality instructions" },
]);

// Codex reasoning effort levels
const CODEX_EFFORT_OPTIONS = Object.freeze([
  { value: "low", label: "low", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Greater reasoning depth" },
  { value: "xhigh", label: "xhigh", desc: "Extra-high reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
  { value: "ultra", label: "ultra", desc: "Max reasoning + automatic task delegation" },
]);

// Hermes thinking levels (hermes_constants.py VALID_REASONING_EFFORTS; "none" disables)
const HERMES_EFFORT_OPTIONS = Object.freeze([
  { value: "none", label: "none", desc: "Thinking off" },
  { value: "minimal", label: "minimal", desc: "Barely think" },
  { value: "low", label: "low", desc: "Fastest reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning for hard tasks" },
  { value: "xhigh", label: "xhigh", desc: "Extra-high reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
  { value: "ultra", label: "ultra", desc: "Highest reasoning" },
]);

// Only models without a tier suffix accept --effort in Antigravity
const ANTIGRAVITY_EFFORT_OPTIONS = Object.freeze([
  { value: "low", label: "low", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning for hard tasks" },
]);

const CLAUDE_EFFORT_OPTIONS = Object.freeze([
  ...EFFORT_OPTIONS,
  { value: "xhigh", label: "xhigh", desc: "Extra-high reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
  { value: "ultracode", label: "ultracode", desc: "Highest: max reasoning + dynamic workflows" },
]);

// Slash command definitions: action determines dispatch (send, clear, modal, submenu)
const DEFAULT_SLASH_COMMANDS = Object.freeze([
  { name: "/clear", description: "Clear conversation context and history", action: "clear" },
  { name: "/model", description: "Select or change active AI model", action: "modal:model" },
  { name: "/mcp", description: "List and manage MCP servers", action: "modal:mcp" },
  { name: "/skills", description: "List available agent skills", action: "modal:skills" },
  { name: "/tasks", description: "View background tasks and checklist", action: "modal:tasks" },
  { name: "/resume", description: "Resume a previous conversation in this project", action: "modal:sessions" },
  { name: "/rewind", description: "Go back to an earlier prompt in this conversation", action: "modal:rewind" },
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

export const DEFAULT_CONFIG = Object.freeze({
  tools: DEFAULT_TOOL_MAP,
  models: DEFAULT_MODELS,
  permissionModes: DEFAULT_PERMISSION_MODES,
  defaultMode: "bypassPermissions",
  defaultEffort: "",
  features: DEFAULT_FEATURES,
  slashCommands: DEFAULT_SLASH_COMMANDS,
  // A cli_event type → { text(record), level } the engine phrases itself; everything
  // undeclared falls to the generic reader in lib/harnessTasks.js (NOTICE_TEXTS).
  notices: Object.freeze({}),
  // A running question tool renders pinned above the composer on engines whose CLI can
  // be answered through it; elsewhere it stays a plain row (headless engines cannot).
  questionGate: false,
  // The engine runs headless and auto-skips every question — the card says so.
  headlessQuestions: false,
});

const VARIANT_OPTIONS = Object.freeze([
  { value: "minimal", label: "minimal", desc: "Fastest, least reasoning" },
  { value: "medium", label: "medium", desc: "Balanced default" },
  { value: "high", label: "high", desc: "Deeper reasoning" },
  { value: "max", label: "max", desc: "Maximum reasoning" },
]);

export class AiEngine {
  constructor({ meta, ui = null, overrides = {} }) {
    if (!meta?.id) throw new Error("AiEngine requires meta.id");
    this.meta = meta;
    this.ui = ui;
    this.overrides = overrides;
    this._config = null;
  }

  get id() {
    return this.meta.id;
  }

  get config() {
    if (this._config) return this._config;
    const o = this.overrides;
    this._config = Object.freeze({
      tools: { ...DEFAULT_CONFIG.tools, ...(o.tools || {}) },
      models: o.models || DEFAULT_CONFIG.models,
      permissionModes: o.permissionModes || DEFAULT_CONFIG.permissionModes,
      defaultMode: o.defaultMode || DEFAULT_CONFIG.defaultMode,
      defaultEffort: o.defaultEffort || DEFAULT_CONFIG.defaultEffort,
      features: { ...DEFAULT_CONFIG.features, ...(o.features || {}) },
      slashCommands: o.slashCommands || DEFAULT_CONFIG.slashCommands,
      notices: o.notices || DEFAULT_CONFIG.notices,
      questionGate: o.questionGate ?? DEFAULT_CONFIG.questionGate,
      headlessQuestions: o.headlessQuestions ?? DEFAULT_CONFIG.headlessQuestions,
    });
    return this._config;
  }

  getToolCategory(toolName) {
    // Avoid matching Object.prototype properties
    const cat = Object.prototype.hasOwnProperty.call(this.config.tools, toolName)
      ? this.config.tools[toolName]
      : null;
    return typeof cat === "string" ? cat : "generic";
  }

  parseTaskEvent(toolName, input, toolCallId, currentTasks = []) {
    return null;
  }

  parseTaskResult(toolName, output, toolCallId) {
    return null;
  }

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
          status: TODO_STATUS[t.status] || t.status || "pending",
        })),
    };
  }
}

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
      overrides: { questionGate: true },
    });
  }

  parseTaskEvent(toolName, input, toolCallId, currentTasks = []) {
    if (toolName === "TaskCreate" && input?.subject) {
      return {
        id: toolCallId,
        // Task ID is assigned by CLI in result; matched by toolCallId meanwhile
        taskId: "",
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
    if (toolName === "TodoWrite") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }

  parseTaskResult(toolName, output, toolCallId) {
    if (typeof output !== "string") return null;
    const match = /Task #(\d+) created/i.exec(output);
    return match ? { id: toolCallId, taskId: match[1] } : null;
  }
}

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
        tools: {
          command_execution: "bash",
          command: "bash",
          file_change: "diff",
          shell: "bash",
          patch: "diff",
          apply: "diff",
          read_file: "file",
          read: "file",
          list_files: "file",
          view_image: "file",
          image_generation: "file",
          todo_list: "task",
          web_search: "search",
          search: "search",
          // Codex collab_tool_call sub-agents
          spawn_agent: "agent",
          wait: "agent",
          resume_agent: "agent",
          send_input: "agent",
          close_agent: "agent",
          send_message: "agent",
          followup_task: "agent",
          interrupt_agent: "agent",
          list_agents: "agent",
        },
        // Fallback models when host catalog cannot be read
        models: [
          { id: "gpt-6-astra", label: "GPT-6-Astra", short: "6 Astra" },
          { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", short: "5.6 Sol" },
          { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", short: "5.6 Terra" },
          { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", short: "5.6 Luna" },
          { id: "gpt-5.5", label: "GPT-5.5", short: "5.5" },
          { id: "gpt-5.2", label: "GPT-5.2", short: "5.2" },
        ],
        permissionModes: [
          { id: "plan", label: "Plan", desc: "Explore and propose without changing anything", icon: PERMISSION_ICONS.readonly },
          { id: "readOnly", label: "Read Only", desc: "Read the workspace; ask before editing", icon: PERMISSION_ICONS.ask },
          { id: "default", label: "Default", desc: "Read and write the workspace", icon: PERMISSION_ICONS.edit },
          { id: "fullAccess", label: "Full Access", desc: "Edit anywhere and reach the network, no prompts", icon: PERMISSION_ICONS.bypass },
        ],
        defaultMode: "fullAccess",
        defaultEffort: "xhigh",
        features: { thinking: true, planMode: true, tasks: true, skills: true, mcp: true, rewind: true },
        slashCommands: [
          { name: "/model", description: "Choose the Codex model and reasoning effort", action: "modal:model" },
          { name: "/effort", description: "Reasoning effort (model_reasoning_effort)", action: "submenu", optionKey: "effort", subOptions: CODEX_EFFORT_OPTIONS },
          { name: "/plan", description: "Switch the session into plan mode", action: "setMode", mode: "plan" },
          { name: "/permissions", description: "Set what Codex may do without asking", action: "modal:mode" },
          { name: "/personality", description: "Assistant communication style", action: "submenu", optionKey: "personality", subOptions: PERSONALITY_OPTIONS },
          { name: "/diff", description: "Show the working tree diff", action: "send" },
          { name: "/review", description: "Review the working tree for bugs and missing tests", action: "send" },
          { name: "/status", description: "Show workspace status and configuration", action: "send" },
          { name: "/goal", description: "Set or view this thread's persistent goal", action: "send" },
          { name: "/rewind", description: "Go back to an earlier prompt in this conversation", action: "modal:rewind" },
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
      ui: { id: "opencode-ui", label: "OpenCode UI", short: "OpenCode UI" },
      overrides: {
        tools: {
          bash: "bash",
          edit: "diff",
          write: "diff",
          patch: "diff",
          apply_patch: "diff",
          read: "file",
          task: "agent",
          todowrite: "task",
          webfetch: "search",
          websearch: "search",
          glob: "search",
          grep: "search",
          list: "search",
          view: "file",
          skill: "generic",
          plan_enter: "plan",
          plan_exit: "plan",
        },
        models: [],
        permissionModes: [
          { id: "auto", label: "Auto", desc: "Full tool access (build agent)", icon: PERMISSION_ICONS.bypass },
          { id: "plan", label: "Plan", desc: "Read-only planning (plan agent)", icon: PERMISSION_ICONS.ask },
        ],
        defaultMode: "auto",
        features: { thinking: true, planMode: true, tasks: false, skills: false, mcp: false, rewind: true },
        questionGate: true,
        slashCommands: [
          { name: "/model", description: "Choose the OpenCode model", action: "modal:model" },
          { name: "/variant", description: "Model variant / reasoning effort", action: "submenu", optionKey: "variant", subOptions: VARIANT_OPTIONS },
          { name: "/mcp", description: "View and manage OpenCode MCP servers", action: "modal:mcp" },
          { name: "/resume", description: "Resume a previous OpenCode session", action: "modal:sessions" },
          { name: "/rewind", description: "Go back to an earlier prompt in this conversation", action: "modal:rewind" },
          { name: "/clear", description: "Start a fresh OpenCode session", action: "clear" },
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

export class OmpEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "omp",
        label: "OMP",
        desc: "oh-my-pi coding agent (rpc mode)",
        badge: "OMP",
        icon: "Zap",
        color: "#f59e0b",
      },
      ui: { id: "omp-ui", label: "OMP UI", short: "OMP UI" },
      overrides: {
        tools: {
          bash: "bash",
          eval: "bash",
          edit: "diff",
          write: "diff",
          ast_edit: "diff",
          memory_edit: "diff",
          read: "file",
          task: "agent",
          todo: "task",
          todowrite: "task",
          glob: "search",
          grep: "search",
          ast_grep: "search",
          web_search: "search",
          recall: "search",
          retain: "search",
          reflect: "search",
          learn: "search",
          ask: "question",
        },
        models: [],
        permissionModes: [
          { id: "default", label: "Default", desc: "Ask before risky tools", icon: PERMISSION_ICONS.ask },
          { id: "auto", label: "Auto", desc: "Auto-approve everything", icon: PERMISSION_ICONS.bypass },
        ],
        defaultMode: "auto",
        features: { thinking: true, planMode: false, tasks: true, skills: false, mcp: false, rewind: true },
        questionGate: true,
        slashCommands: [
          { name: "/model", description: "Choose the OMP model", action: "modal:model" },
          { name: "/effort", description: "Thinking level (set_thinking_level)", action: "submenu", optionKey: "effort", subOptions: EFFORT_OPTIONS },
          { name: "/resume", description: "Resume a previous OMP session", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh OMP session", action: "clear" },
          { name: "/doctor", description: "Check the OMP installation", action: "modal:doctor" },
          { name: "/rewind", description: "Go back to an earlier prompt in this conversation", action: "modal:rewind" },
        ],
      },
    });
  }

  parseTaskEvent(toolName, input, toolCallId) {
    if (toolName === "todowrite" || toolName === "todo") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }
}

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
      ui: { id: "antigravity-ui", label: "Antigravity UI", short: "Antigravity UI" },
      overrides: {
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
        // CLI rejects models with tier suffix beside --effort
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
        permissionModes: [
          { id: "plan", label: "Plan", desc: "Explore and plan without modifying code", icon: PERMISSION_ICONS.readonly },
          { id: "accept-edits", label: "Accept Edits", desc: "Auto-approve every tool the agent calls", icon: PERMISSION_ICONS.edit },
        ],
        defaultMode: "accept-edits",
        features: { thinking: true, planMode: true, tasks: false, skills: false, mcp: false, rewind: false },
        headlessQuestions: true,
        slashCommands: [
          { name: "/model", description: "Choose the Antigravity model", action: "modal:model" },
          { name: "/effort", description: "Reasoning effort (--effort)", action: "submenu", optionKey: "effort", subOptions: ANTIGRAVITY_EFFORT_OPTIONS },
          { name: "/resume", description: "Resume a previous Antigravity conversation", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh Antigravity conversation", action: "clear" },
          { name: "/doctor", description: "Check the Antigravity CLI installation", action: "modal:doctor" },
          { name: "/plan", description: "Switch the session into read-only plan mode", action: "setMode", mode: "plan" },
        ],
      },
    });
  }
}

export class DevinEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "devin",
        label: "Devin",
        desc: "Devin CLI agent (acp mode)",
        badge: "Devin",
        icon: "Compass",
        color: "#6d5dfc",
      },
      ui: { id: "devin-ui", label: "Devin UI", short: "Devin UI" },
      overrides: {
        // Tool names are the wire's inferenceToolName; unknowns fall back to the ACP kind.
        tools: {
          exec: "bash",
          edit: "diff",
          write: "diff",
          read: "file",
          glob: "search",
          grep: "search",
          search: "search",
          web_search: "search",
          fetch: "search",
          list_dir: "search",
          think: "thought",
          todo: "task",
          ask: "question",
        },
        models: [
          { id: "swe-1-6-slow", label: "SWE-1.6 Slow", short: "SWE-1.6 Slow", desc: "Low cost balanced default", provider: "Devin" },
          { id: "swe-1-7", label: "SWE-1.7 Max", short: "SWE-1.7 Max", provider: "Devin" },
          { id: "swe-2-high", label: "SWE-2 High", short: "SWE-2 High", provider: "Devin" },
          { id: "claude-opus-5-medium", label: "Claude Opus 5 Medium", short: "Opus 5 M", provider: "Anthropic" },
          { id: "claude-sonnet-5-medium", label: "Claude Sonnet 5 Medium", short: "Sonnet 5 M", provider: "Anthropic" },
          { id: "claude-fable-5-1-medium", label: "Claude Fable 5.1 Medium", short: "Fable 5.1 M", provider: "Anthropic" },
          { id: "gpt-5-6-sol-medium", label: "GPT-5.6 Sol Medium Thinking", short: "5.6 Sol M", provider: "OpenAI" },
          { id: "gpt-6-astra-medium", label: "GPT-6 Astra Medium Thinking", short: "6 Astra M", provider: "OpenAI" },
        ],
        // The ACP wire has no set-mode method: the mode travels only as the
        // config the CLI itself holds — one mode, shown, not switched.
        permissionModes: [
          { id: "accept-edits", label: "Code", desc: "Auto-approve reads and edits (set in Devin)", icon: PERMISSION_ICONS.edit },
        ],
        defaultMode: "accept-edits",
        features: { thinking: true, planMode: false, tasks: false, skills: false, mcp: false, rewind: false },
        questionGate: true,
        slashCommands: [
          { name: "/model", description: "Choose the Devin model", action: "modal:model" },
          { name: "/resume", description: "Resume a previous Devin session", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh Devin session", action: "clear" },
          { name: "/doctor", description: "Check the Devin installation", action: "modal:doctor" },
        ],
      },
    });
  }
}

export class HermesEngine extends AiEngine {
  constructor() {
    super({
      meta: {
        id: "hermes",
        label: "Hermes",
        desc: "Hermes CLI agent (acp mode)",
        badge: "Hermes",
        icon: "Send",
        color: "#22d3ee",
      },
      ui: { id: "hermes-ui", label: "Hermes UI", short: "Hermes UI" },
      overrides: {
        // Canonical tool names the adapter derives from hermes' titled tool calls.
        // The hermes-acp toolset (toolsets.py _CODING_TOOLS): coding posture minus clarify.
        tools: {
          terminal: "bash",
          process_manage: "bash",
          process: "bash",
          execute_code: "bash",
          read_file: "file",
          vision_analyze: "file",
          write_file: "diff",
          patch: "diff",
          search_files: "search",
          web_search: "search",
          web_extract: "search",
          session_search: "search",
          browser_navigate: "search",
          browser_snapshot: "file",
          browser_get_images: "file",
          browser_vision: "file",
          delegate_task: "agent",
          todo_list: "task",
          todo: "task",
        },
        models: [],
        // The ACP mode ids (acp_adapter/server.py _MODES); dont_ask is the --yolo spawn tier.
        permissionModes: [
          { id: "default", label: "Default", desc: "Ask before edits", icon: PERMISSION_ICONS.ask },
          { id: "accept_edits", label: "Accept Edits", desc: "Auto-allow workspace edits, ask for sensitive paths", icon: PERMISSION_ICONS.edit },
          { id: "dont_ask", label: "Don't Ask (full)", desc: "Spawn with --yolo: every approval bypassed except hermes' own deny floors", icon: PERMISSION_ICONS.bypass },
        ],
        // Full permission out of the box, like the pane's other engines default.
        defaultMode: "dont_ask",
        features: { thinking: true, planMode: false, tasks: true, skills: true, mcp: false, rewind: false },
        // The commands hermes' ACP server advertises (acp_adapter/commands.py _COMMANDS);
        // an unrecognized '/' falls through to the model as a normal message.
        slashCommands: [
          { name: "/model", description: "Choose the Hermes model", action: "modal:model" },
          { name: "/effort", description: "Thinking level (config.yaml)", action: "submenu", optionKey: "effort", subOptions: HERMES_EFFORT_OPTIONS },
          { name: "/resume", description: "Resume a previous Hermes session", action: "modal:sessions" },
          { name: "/clear", description: "Start a fresh Hermes session", action: "clear" },
          { name: "/doctor", description: "Check the Hermes installation", action: "modal:doctor" },
          { name: "/help", description: "List available commands", action: "send" },
          { name: "/tools", description: "List available tools with descriptions", action: "send" },
          { name: "/context", description: "Show conversation message counts by role", action: "send" },
          { name: "/compress", description: "Compress conversation context", action: "send" },
          { name: "/reset", description: "Clear conversation history", action: "send" },
          { name: "/version", description: "Show Hermes version", action: "send" },
        ],
      },
    });
  }

  parseTaskEvent(toolName, input, toolCallId) {
    if (toolName === "todo_list" || toolName === "todo") return this._parseReplaceAllTodos(input, toolCallId);
    return null;
  }
}

export const DEFAULT_ENGINE_ID = "claude";

const registry = new Map();

export function registerEngine(engine) {
  if (!(engine instanceof AiEngine)) throw new Error("registerEngine expects an AiEngine");
  registry.set(engine.id, engine);
  return engine;
}

export function getEngine(engineId) {
  return registry.get(engineId) || registry.get(DEFAULT_ENGINE_ID);
}

export function listEngineInstances() {
  return [...registry.values()];
}

registerEngine(new ClaudeEngine());
registerEngine(new CodexEngine());
registerEngine(new OpenCodeEngine());
registerEngine(new AntigravityEngine());
registerEngine(new OmpEngine());
registerEngine(new DevinEngine());
registerEngine(new HermesEngine());

export function getEngineConfig(engineId = DEFAULT_ENGINE_ID) {
  return getEngine(engineId).config;
}

export function getEngineInfo(engineId = DEFAULT_ENGINE_ID) {
  return getEngine(engineId).meta;
}

export function listEngines() {
  return listEngineInstances().map((e) => e.meta);
}

export function listAiUiOptions() {
  return listEngineInstances().filter((e) => e.ui).map((e) => ({ ...e.ui, isAiUi: true, aiEngine: e.id }));
}

export function getToolCategory(engineId, toolName) {
  return getEngine(engineId).getToolCategory(toolName);
}

export function parseEngineTaskEvent(engineId, toolName, input, toolCallId, currentTasks = []) {
  return getEngine(engineId).parseTaskEvent(toolName, input, toolCallId, currentTasks);
}

export function parseEngineTaskResult(engineId, toolName, output, toolCallId) {
  return getEngine(engineId).parseTaskResult(toolName, output, toolCallId);
}
