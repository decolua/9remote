// The line at the tail of a live turn: what the agent is doing right now.
//
// This is a read model over state the pane already has, not a new source of truth —
// one pure function so the wording is testable without a renderer. The verb names the
// kind of work; the detail names the specific thing it is working on.

import { getToolCategory } from "../registry";

// Longest detail worth showing before it pushes the token readout off the row.
const MAX_DETAIL = 60;

// Basename only: a detail line is a glance, and the full path is already in the card.
const baseName = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "" : "");

// Last non-empty line of a streamed block — the freshest thing written, and short.
const lastLine = (text) => {
  if (typeof text !== "string") return "";
  const lines = text.split("\n").filter((l) => l.trim());
  return (lines[lines.length - 1] || "").trim();
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

// Roughly 4 characters per token, the same trick the CLIs use so the counter ticks
// while the host has not reported usage yet.
const ESTIMATED_CHARS_PER_TOKEN = 4;

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
