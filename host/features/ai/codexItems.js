// Maps codex rollout records to wire events.
import { toolStart, toolResult } from "./toolEvent.js";

// Extract all touched paths from a codex item.
export function changePaths(item) {
  if (Array.isArray(item?.changes)) return item.changes.map((c) => c.path).filter(Boolean);
  if (item?.changes) return Object.keys(item.changes);
  if (Array.isArray(item?.paths)) return item.paths;
  return item?.path ? [item.path] : [];
}

// Build diffs for changed files in a codex item.
export function fileChangeDiffs(item, recorded) {
  const changes = Array.isArray(item?.changes)
    ? item.changes
    : Object.entries(item?.changes || {}).map(([path, change]) => ({ path, ...change }));
  const out = [];
  for (const change of changes) {
    const file = change.path || "";
    if (!file) continue;
    const rec = recorded?.[file] || {};
    const kind = change.kind || change.type || "";
    const raw = change.unified_diff || change.diff || change.patch || rec.patch || "";
    const body = raw ? "" : (change.content || rec.content || "");
    const patch = body ? body.replace(/\n$/, "").split("\n").map((l) => `${kind === "delete" ? "-" : "+"}${l}`).join("\n") : raw;
    if (patch) out.push({ file, patch, content: "" });
  }
  return out;
}

// Item type to client category mapping (handles snake_case and PascalCase).
const ITEM_CATEGORY = Object.freeze({
  command_execution: "command",
  CommandExecution: "command",
  file_change: "file_change",
  FileChange: "file_change",
  mcp_tool_call: "mcp_tool_call",
  McpToolCall: "mcp_tool_call",
  collab_tool_call: "collab_tool_call",
  CollabAgentToolCall: "collab_tool_call",
  todo_list: "todo_list",
  TodoList: "todo_list",
  web_search: "web_search",
  WebSearch: "web_search",
  ImageView: "view_image",
  imageView: "view_image",
  EnteredReviewMode: "enteredReviewMode",
  enteredReviewMode: "enteredReviewMode",
  ExitedReviewMode: "exitedReviewMode",
  exitedReviewMode: "exitedReviewMode"
});

// Friendly names for parsed command types.
const PARSED_NAMES = Object.freeze({ read: "read", search: "search", list_files: "list_files" });

export function isCodexToolItem(type) {
  return Boolean(ITEM_CATEGORY[type]);
}

export function isCodexFileChange(item) {
  return ITEM_CATEGORY[item?.type] === "file_change";
}

/** Convert codex item payload into tool events (start, result, diffs). */
export function codexItemEvents(payload, recorded = null) {
  const item = payload?.item || payload;
  const type = item?.type;
  const tool = ITEM_CATEGORY[type];
  if (!tool) return [];

  const cmd = item.command ?? item.command_line;
  const parsed = tool === "command" ? parsedCall(item) : null;
  const input =
    tool === "command" ? { ...parsed, command: parsed.command || commandLine(cmd) }
    : tool === "file_change" ? changeInput(item)
    : tool === "mcp_tool_call" ? { server: item.server, ...(item.arguments || item.input || {}) }
    : tool === "collab_tool_call" ? (item.prompt ? { subagent_type: item.tool, prompt: item.prompt } : {})
    : tool === "todo_list" ? { todos: item.items || item.todos || [] }
    : tool === "view_image" ? { path: item.path || "", file_path: item.path || "" }
    : tool === "enteredReviewMode" || tool === "exitedReviewMode"
      ? { review: item.user_facing_hint || item.review || reviewTarget(item.target) }
    : { path: item.path || "" };

  const name = item.tool || parsed?.name || tool;

  const done = payload?.status === "completed" || payload?.type === "item_completed" || item.status === "completed";
  const events = [toolStart({ id: item.id, name, input })];
  if (!done) return events;

  if (tool === "command") {
    const output = item.aggregated_output ?? item.stdout ?? "";
    const exit = item.exit_code ?? item.exitCode;
    events.push(
      exit
        ? toolResult({ id: item.id, name, error: `${output}\n(exit ${exit})`.trim() })
        : toolResult({ id: item.id, name, output })
    );
    return events;
  }

  if (tool === "file_change") {
    for (const d of fileChangeDiffs(item, recorded)) events.push({ event: "diff", data: d });
    events.push(toolResult({ id: item.id, name: tool, output: "" }));
    return events;
  }

  if (tool === "collab_tool_call") {
    const states = Object.values(item.agents_states || {});
    const errored = states.find((s) => (typeof s === "string" ? s : s?.status) === "errored");
    const failed = item.status === "failed" || Boolean(errored);
    const reason = typeof errored === "string" ? "" : errored?.message || "";
    events.push(
      failed
        ? toolResult({ id: item.id, name: item.tool || tool, error: reason || `Codex reported ${item.tool} as ${item.status}` })
        : toolResult({ id: item.id, name: item.tool || tool, output: "" })
    );
    return events;
  }

  const output = item.result ?? item.output ?? item.query ?? "";
  const failed = Boolean(item.isError);
  events.push(
    failed
      ? toolResult({ id: item.id, name: item.tool || tool, error: errorText(output) })
      : toolResult({ id: item.id, name: item.tool || tool, output: textOf(output) })
  );
  return events;
}

function commandLine(command) {
  if (Array.isArray(command)) return command.join(" ");
  return command || "";
}

/** Format review target into human-readable phrase. */
function reviewTarget(target) {
  if (!target || typeof target !== "object") return "";
  const type = target.type || "";
  if (type === "uncommittedChanges") return "uncommitted changes";
  return target.branch || target.commit || target.sha || type || "";
}

// Extract clean command and tool name from parsed_cmd if present.
function parsedCall(item) {
  const parts = (item.parsed_cmd || []).filter((p) => p?.cmd);
  const first = parts[0];
  const name = PARSED_NAMES[first?.type];
  return {
    command: parts.map((p) => p.cmd).join("; "),
    name: name || null,
    ...(first?.path ? { path: first.path, file_path: first.path } : {}),
    ...(first?.query ? { query: first.query } : {})
  };
}

function changeInput(item) {
  const paths = changePaths(item);
  return { file_path: paths[0] || "", path: paths[0] || "", paths };
}

function textOf(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((c) => c?.text || "").join("");
  return output ? JSON.stringify(output) : "";
}

function errorText(output) {
  return textOf(output) || "Codex reported this tool call as failed.";
}
