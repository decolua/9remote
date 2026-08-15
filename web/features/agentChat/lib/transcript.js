// Turns the agent's hook timeline into rows the chat view can render.
import { TOOL_CATEGORY, GROUP_THRESHOLD, PREVIEW_MAX_CHARS } from "../constants/agentChatConfig.js";

export const toolCategory = (toolName) => TOOL_CATEGORY[toolName] || "default";

const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

const truncate = (s, max = PREVIEW_MAX_CHARS) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** Short label for a tool call — what the user scans down the left of the transcript. */
export function describeTool(toolName, toolInput) {
  if (!toolInput) return "";
  const i = toolInput;
  if (i.file_path) return truncate(basename(i.file_path));
  if (i.notebook_path) return truncate(basename(i.notebook_path));
  if (i.command) return truncate(String(i.command));
  if (i.pattern) return truncate(String(i.pattern));
  if (i.description) return truncate(String(i.description));
  if (i.subagent_type) return truncate(String(i.subagent_type));
  if (i.url) return truncate(String(i.url));
  if (i.query) return truncate(String(i.query));
  if (i.prompt) return truncate(String(i.prompt));
  return "";
}

// Only a settled, successful call may disappear into a group. An error or a call still in
// flight always keeps its own row — collapsing those hides exactly what needs attention.
const isGroupable = (e) => e?.kind === "tool" && e.status === "done";

function makeGroup(entries, startIndex) {
  const labels = entries.slice(0, 2).map((e) => describeTool(e.toolName, e.toolInput)).filter(Boolean);
  const rest = entries.length - labels.length;
  const preview = [labels.join(", "), rest > 0 ? `+${rest} more` : ""].filter(Boolean).join(", ");
  return {
    type: "group",
    key: `g${startIndex}-${entries[0].toolName}-${entries.length}`,
    toolName: entries[0].toolName,
    count: entries.length,
    preview,
    entries,
  };
}

/** Collapse runs of identical settled tool calls; everything else stays on its own row. */
export function groupActivity(activity) {
  if (!Array.isArray(activity) || activity.length === 0) return [];
  const rows = [];
  let i = 0;
  while (i < activity.length) {
    const entry = activity[i];
    // Anything that is not a settled tool call is speech or state — it renders as itself.
    // Unknown kinds fall through here too: dropping them would hide real conversation.
    if (entry?.kind && entry.kind !== "tool") {
      rows.push({ type: entry.kind, key: entry.id || `${entry.kind}${i}`, entry });
      i++;
      continue;
    }
    if (isGroupable(entry)) {
      let end = i + 1;
      while (end < activity.length && isGroupable(activity[end]) && activity[end].toolName === entry.toolName) end++;
      const run = activity.slice(i, end);
      if (run.length >= GROUP_THRESHOLD) {
        rows.push(makeGroup(run, i));
        i = end;
        continue;
      }
    }
    rows.push({ type: "tool", key: `t${i}-${entry?.toolName || "x"}`, entry });
    i++;
  }
  return rows;
}
