// Shared Jarvis facts — the one place the web names columns, the conductor's
// session id, and the settings defaults. The agent's column list lives in
// agent/features/jarvis/jarvisKanban.js and must stay in sync with this one.

// The fixed AI session id the Jarvis chat pane runs under, on every surface.
export const JARVIS_SESSION_ID = "jarvis";

// Column order of the kanban board, left to right.
export const KANBAN_STATUSES = ["todo", "in_progress", "needs_input", "done"];

// Feature parking brake: false hides every Jarvis entry point everywhere,
// regardless of the per-device toggle below. Flip to true when work resumes.
export const JARVIS_ENABLED = false;

// Coordinator settings, per-device (persisted by the store that owns them).
// Model/effort are deliberately absent: they live on the chat session itself,
// changed through the pane's own model picker.
export const JARVIS_DEFAULT_SETTINGS = {
  enabled: true,           // master switch: hides every entry point when off
  // The chat LLM: format + endpoint are free — any function-calling provider.
  llmProvider: "gemini",   // gemini | openai | anthropic
  llmBaseUrl: "",          // empty = the provider's own default (openai → OpenRouter)
  llmKey: "",              // the chat model's API key
  agentModel: "gemini-3.8-flash",
  boardScope: "workspace", // board filter: this workspace | all workspaces
  wakeOnDone: true,        // worker finished → wake the Jarvis chat (costs a turn)
  liveKey: "",             // Google AI key for the live voice conductor
  liveModel: "gemini-3.8-live",
  liveVoice: "Puck"        // Gemini prebuilt voice for live mode
};

// Label + placeholder per provider — one place, both used by the settings UI.
export const JARVIS_LLM_PROVIDERS = [
  { id: "gemini", label: "Google Gemini", baseUrlHint: "https://generativelanguage.googleapis.com (default)", models: ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-pro"] },
  { id: "openai", label: "OpenAI-compatible", baseUrlHint: "https://openrouter.ai/api/v1 (default)", models: ["openai/gpt-5", "anthropic/claude-sonnet-5", "google/gemini-3.8-flash"] },
  { id: "anthropic", label: "Anthropic", baseUrlHint: "https://api.anthropic.com (default)", models: ["claude-sonnet-5", "claude-haiku-4-5"] }
];

export const JARVIS_LS_KEY = "jarvisSettings";

// ── Live voice conductor (Gemini 3.8 Live, speech-to-speech) ──
// The live model id is stable per Google's model page; bump here when it changes.
export const JARVIS_LIVE_MODEL = "gemini-3.8-live";
export const JARVIS_LIVE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda"];

export const JARVIS_LIVE_SYSTEM_PROMPT =
  "You are Jarvis, the conductor coordinating AI agents (claude, codex, opencode) on the user's machine. " +
  "The user talks to you to delegate work and ask about status. Rules: call list_fleet before delegating to see which session is free; " +
  "delegate with dispatch_prompt to an existing session, or create_session to open a new one (pass the workspace taken from " +
  "list_fleet's workspacePath); record every job on the board with manage_kanban; when an agent asks or requests permission, " +
  "use resolve_gate per the user's intent; to see what a worker printed, read_terminal. " +
  "Reply BRIEFLY in the user's language, natural spoken style — never read out raw JSON.";

// Map the agent's MCP manifest to Gemini Live functionDeclarations. The Live API
// expects upper-case type strings in its schema subset; our schemas are plain
// (object/string/number/boolean/enum/required), so the mapping is a case change.
function upcaseTypes(node) {
  if (Array.isArray(node)) return node.map(upcaseTypes);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === "type" && typeof value === "string" ? value.toUpperCase() : upcaseTypes(value);
    }
    return out;
  }
  return node;
}

export function liveToolDeclarations(manifest = []) {
  return manifest
    .filter((tool) => tool?.name && tool?.description)
    .map(({ name, description, inputSchema }) => ({
      name,
      description,
      ...(inputSchema ? { parameters: upcaseTypes(inputSchema) } : {})
    }));
}
