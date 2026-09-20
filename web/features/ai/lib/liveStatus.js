// Formats live activity status for the active turn.
import { getToolCategory } from "../registry";

export function describeActivity(tool, engine = "claude") {
  if (!tool?.name) return "";
  const { name, input = {} } = tool;
  const path = baseName(input.file_path || input.path);
  switch (getToolCategory(engine, name)) {
    case "bash":
      return clip(input.description || input.command || "shell", MAX_DETAIL);
    case "file":
      return clip(`${/^(list|list_dir|ls)$/i.test(name) ? "Listing" : "Reading"} ${path}`, MAX_DETAIL);
    case "search":
      return clip([input.pattern ? `"${input.pattern}"` : input.query || input.url || "", path ? `in ${path}` : ""].filter(Boolean).join(" "), MAX_DETAIL);
    case "diff":
      return clip(`${/^(Write|write_to_file)$/i.test(name) ? "Writing" : "Editing"} ${baseName(input.file_path || input.filePath || input.file || input.path) || argOf(input)}`, MAX_DETAIL);
    case "agent":
      return clip(input.description || argOf(input) || "sub-agent", MAX_DETAIL);
    case "plan":
      return clip(baseName(input.path) || name, MAX_DETAIL);
    default:
      return clip([toolLabel(name), argOf(input)].filter(Boolean).join(" "), MAX_DETAIL);
  }
}

const MAX_DETAIL = 60;
// Scan only tail of streamed block to find last line efficiently.
const TAIL_SCAN = 512;

const baseName = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "" : "");

const lastLine = (text) => {
  if (typeof text !== "string") return "";
  const lines = text.slice(-TAIL_SCAN).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
};

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// `mcp__github__create_issue` → `create_issue`. The server is noise on a one-line status.
const toolLabel = (name = "") => {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return mcp ? mcp[1] : name;
};

const argOf = (input = {}) =>
  input.url || input.query || input.pattern || input.name || baseName(input.path) || baseName(input.file_path) || "";

export function describeLive({ connected = true, hydrating = false, retryStatus = null, activeTool = null, engine = "", lastMsg = null } = {}) {
  // Offline outranks everything: no other line is true while there is no carrier.
  if (!connected) {
    const r = retryStatus || {};
    const detail = r.isRetrying
      ? `attempt ${r.attempt}/${r.maxAttempts}${r.failed ? " · gave up" : ""}`
      : "";
    return { verb: "Reconnecting", detail, tone: "alert" };
  }
  if (hydrating) return { verb: "Syncing", detail: "from host", tone: "wait" };

  if (activeTool?.name) {
    const { name, input = {} } = activeTool;
    const cat = getToolCategory(engine, name);
    const path = baseName(input.file_path || input.path);

    switch (cat) {
      case "bash":
        return { verb: "Running", detail: clip(input.command || "", MAX_DETAIL), tone: "wait" };
      case "file": {
        const listing = /^(list|list_dir|ls)$/i.test(name);
        const line = input.offset ? `:L${input.offset}` : "";
        return { verb: listing ? "Listing" : "Reading", detail: clip(`${path}${line}`, MAX_DETAIL), tone: "wait" };
      }
      case "search": {
        const q = input.pattern ? `"${input.pattern}"` : (input.query || input.url || "");
        const where = baseName(input.path);
        return {
          verb: "Searching",
          detail: clip([q, where ? `in ${where}` : ""].filter(Boolean).join(" "), MAX_DETAIL),
          tone: "wait"
        };
      }
      case "diff": {
        const creating = /^(Write|write_to_file)$/i.test(name);
        // Normalize target file path across engine adapters.
        const file = input.file_path || input.filePath || input.file || input.path;
        return { verb: creating ? "Writing" : "Editing", detail: clip(baseName(file) || argOf(input), MAX_DETAIL), tone: "wait" };
      }
      case "agent": {
        const steps = activeTool.children?.length || 0;
        return {
          verb: "Delegating",
          detail: clip([input.description || argOf(input), steps ? `${steps} steps` : ""].filter(Boolean).join(" · "), MAX_DETAIL),
          tone: "wait"
        };
      }
      case "task":
        return { verb: "Updating tasks", detail: clip(input.activeForm || input.subject || "", MAX_DETAIL), tone: "wait" };
      case "plan":
        return { verb: "Planning", detail: clip(baseName(input.path) || name, MAX_DETAIL), tone: "wait" };
      default:
        return { verb: "Calling", detail: clip([toolLabel(name), argOf(input)].filter(Boolean).join(" "), MAX_DETAIL), tone: "wait" };
    }
  }

  if (lastMsg?.thinking) return { verb: "Thinking", detail: clip(lastLine(lastMsg.thinking), MAX_DETAIL), tone: "wait" };
  if (lastMsg?.content) return { verb: "Writing", detail: clip(lastLine(lastMsg.content), MAX_DETAIL), tone: "wait" };
  return { verb: "Working", detail: "", tone: "wait" };
}

// Token counts follow the CLI's shorthand: 1234 → 1.2k, 100000 → 100k, 1000000 → 1M
export function formatTokens(n) {
  const v = Number(n) || 0;
  const unit = v >= 1e6 ? [1e6, "M"] : v >= 1e3 ? [1e3, "k"] : null;
  if (!unit) return String(v);
  const scaled = v / unit[0];
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit[1]}`;
}

// Rough estimate of 4 characters per token while awaiting reported usage.
const ESTIMATED_CHARS_PER_TOKEN = 4;

// Tokens in session context window normalized across engine adapters.
export function contextUsedTokens(stats = {}) {
  if (Number.isFinite(stats.contextTokens) && stats.contextTokens > 0) return stats.contextTokens;
  return (stats.inputTokens || 0) + (stats.cacheReadInputTokens || 0) + (stats.cacheCreationInputTokens || 0);
}

export function contextFill(stats = {}) {
  const used = contextUsedTokens(stats);
  const window = stats.contextWindow || 0;
  return window > 0 ? Math.min(1, used / window) : null;
}

// Estimate tokens streamed across all messages in current turn.
export function estimateTurnTokens(messages = []) {
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    chars += (m.content?.length || 0) + (m.thinking?.length || 0);
  }
  return Math.round(chars / ESTIMATED_CHARS_PER_TOKEN);
}

// Tools that write files; excluded when diff cards exist for the same path.
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "patch", "apply",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "file_change"]);

const lineCount = (text) => (typeof text === "string" && text ? text.split("\n").length : 0);

function countToolEdit(tool) {
  const input = tool.input;
  if (!input || typeof input === "string") return null;
  const path = input.file_path || input.path || input.file || "";
  // MultiEdit (and Antigravity's multi_replace) carry a list of old/new pairs.
  const edits = Array.isArray(input.edits) ? input.edits
    : Array.isArray(input.replacement_chunks) ? input.replacement_chunks
      : Array.isArray(input.replacements) ? input.replacements : null;
  if (edits) {
    let added = 0, removed = 0;
    for (const e of edits) {
      removed += lineCount(e.old_string ?? e.oldString ?? e.old ?? e.target_content);
      added += lineCount(e.new_string ?? e.newString ?? e.new ?? e.replacement_content);
    }
    return { file: path, added, removed };
  }
  if (typeof input.content === "string" && input.content) return { file: path, added: lineCount(input.content), removed: 0 };
  const oldText = input.old_string ?? input.oldString ?? input.old_str
    ?? input.target_content ?? input.TargetContent;
  const newText = input.new_string ?? input.newString ?? input.new_str
    ?? input.replacement_content ?? input.ReplacementContent;
  if (oldText === undefined && newText === undefined) return null;
  return { file: path, added: lineCount(newText), removed: lineCount(oldText) };
}

// Count lines added and removed across turn diffs and tool inputs.
export function countTurnChanges(messages = []) {
  let added = 0, removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;

    const diffs = m.diffs || [];
    for (const d of diffs) {
      const raw = d.patch || d.diff || "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
    }

    const diffFiles = new Set(diffs.map((d) => d.file).filter(Boolean));
    for (const t of m.tools || []) {
      if (!WRITE_TOOLS.has(t?.name)) continue;
      const p = t.input?.file_path || t.input?.path || t.input?.file || "";
      if (p && diffFiles.has(p)) continue;
      const c = countToolEdit(t);
      if (c) { added += c.added; removed += c.removed; }
    }
  }
  return { added, removed };
}
