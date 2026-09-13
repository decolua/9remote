// The line at the tail of a live turn: what the agent is doing right now.
//
// This is a read model over state the pane already has, not a new source of truth —
// one pure function so the wording is testable without a renderer. The verb names the
// kind of work; the detail names the specific thing it is working on.

import { getToolCategory } from "../registry";

// Longest detail worth showing before it pushes the token readout off the row.
const MAX_DETAIL = 60;

// How far back to look for the last line. A status detail is clipped to MAX_DETAIL, so
// the tail that won is a few hundred chars at most — scanning the whole streamed block
// on every token made this O(content) per token, O(content²) per answer.
const TAIL_SCAN = 512;

// Basename only: a detail line is a glance, and the full path is already in the card.
const baseName = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "" : "");

// Last non-empty line of a streamed block — the freshest thing written, and short.
// Only the tail is scanned: blank lines at the end are skipped by walking back rather
// than by filtering the whole block, which is what made this O(content) per token.
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

// The argument that says WHAT this call is about, in the order that reads best.
const argOf = (input = {}) =>
  input.url || input.query || input.pattern || input.name || baseName(input.path) || baseName(input.file_path) || "";

/**
 * What to print while a turn is streaming.
 *
 * @param {object} state
 * @param {boolean} state.connected  Transport is up.
 * @param {boolean} state.hydrating  Re-pulling the host's log (mount/resume/reconnect).
 * @param {object}  [state.retryStatus] { isRetrying, attempt, maxAttempts } from useBus.
 * @param {object}  [state.activeTool] A tool with status "running", or null.
 * @param {string}  [state.engine]
 * @param {object}  [state.lastMsg]    Last message; its thinking/content say which phase.
 * @returns {{verb: string, detail: string, tone: string}} tone: "normal" | "wait" | "alert"
 */
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
        // Read / view / read_resource list a file; list_dir and friends list a folder.
        const listing = /^(list|list_dir|ls)$/i.test(name);
        const line = input.offset ? `:L${input.offset}` : "";
        return { verb: listing ? "Listing" : "Reading", detail: clip(`${path}${line}`, MAX_DETAIL), tone: "wait" };
      }
      case "search": {
        // Grep-style tools carry a pattern; WebSearch/WebFetch carry a query or a URL.
        const q = input.pattern ? `"${input.pattern}"` : (input.query || input.url || "");
        const where = baseName(input.path);
        return {
          verb: "Searching",
          detail: clip([q, where ? `in ${where}` : ""].filter(Boolean).join(" "), MAX_DETAIL),
          tone: "wait"
        };
      }
      case "diff": {
        // The category is "file was modified"; Write creates, the rest rewrite in place.
        const creating = /^(Write|write_to_file)$/i.test(name);
        return { verb: creating ? "Writing" : "Editing", detail: clip(baseName(input.file || input.path) || argOf(input), MAX_DETAIL), tone: "wait" };
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

  // No tool: the phase is whichever stream is currently arriving.
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

// Roughly 4 characters per token, the same trick the CLIs use so the counter ticks
// while the host has not reported usage yet.
const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Tokens sitting in the session's context window.
 *
 * Cached reads count: the CLI's `inputTokens` is only the uncached part, so a resumed
 * conversation reports a few thousand there while the window really holds tens of
 * thousands. Engines that report no cache fields (codex, opencode) already fold
 * everything into `inputTokens`.
 *
 * @param {object} [stats] The host's latest reported usage.
 * @returns {number}
 */
export function contextUsedTokens(stats = {}) {
  return (stats.inputTokens || 0) + (stats.cacheReadInputTokens || 0) + (stats.cacheCreationInputTokens || 0);
}

/**
 * Tokens streamed so far in the turn the user is watching.
 *
 * Summed over the WHOLE turn, not the last message: a tool call closes the streaming
 * segment and opens an empty one, so reading `lastMsg.content` alone dropped the count
 * back to the host's lagging number every time the agent ran a command.
 *
 * @param {Array} messages The session's message list, oldest first.
 * @returns {number} Estimated output tokens since the last user message.
 */
export function estimateTurnTokens(messages = []) {
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    chars += (m.content?.length || 0) + (m.thinking?.length || 0);
  }
  return Math.round(chars / ESTIMATED_CHARS_PER_TOKEN);
}

// Tools that write a file. `visibleTools` hides these once a diff card exists for the
// same path, so counting both would double every edit — see countTurnChanges.
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "patch", "apply",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "file_change"]);

const lineCount = (text) => (typeof text === "string" && text ? text.split("\n").length : 0);

/** Additions/deletions a single tool call would produce, from its input alone. */
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
  // Write/new file: the whole content is new.
  if (typeof input.content === "string" && input.content) return { file: path, added: lineCount(input.content), removed: 0 };
  const oldText = input.old_string ?? input.oldString ?? input.old_str
    ?? input.target_content ?? input.TargetContent;
  const newText = input.new_string ?? input.newString ?? input.new_str
    ?? input.replacement_content ?? input.ReplacementContent;
  if (oldText === undefined && newText === undefined) return null;
  return { file: path, added: lineCount(newText), removed: lineCount(oldText) };
}

/**
 * Lines added and removed across the turn the user is watching, the way the CLIs report
 * it at the end of a run.
 *
 * A diff card wins over the tool that produced it: `visibleTools` already hides that
 * tool, and counting both would report every edit twice. Engines that only send tool
 * inputs (Claude, OpenCode, Antigravity — only Codex emits `diff`) are covered by the
 * input fallback instead, which is why both sources are needed.
 *
 * @param {Array} messages The session's message list, oldest first.
 * @returns {{added: number, removed: number}}
 */
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
      // Already reported by a diff card for this file — the tool is hidden from the turn.
      const p = t.input?.file_path || t.input?.path || t.input?.file || "";
      if (p && diffFiles.has(p)) continue;
      const c = countToolEdit(t);
      if (c) { added += c.added; removed += c.removed; }
    }
  }
  return { added, removed };
}
