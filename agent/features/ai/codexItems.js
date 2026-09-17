// One codex rollout record → the wire events it stands for. The rollout's `item_completed`
// envelope is the SAME item the live `exec --json` stream prints, so the tool mapping here
// is the adapter's own, moved out of its JSON branch verbatim — verified field by field
// against a real record: `aggregated_output`, `exit_code` and `changes` all survive into
// the rollout, so a replayed card shows what the live one showed.
//
// The reader hands over the raw payload, which is `{item, ...}` rather than the item
// itself — hence the `payload.item || payload` at the door, the one step the live path
// does not have.
//
// The two helpers below live here rather than in the adapter so the imports stay a line
// (reader → here, adapter → here) — the adapter reaches the reader for the rollout's
// patches, and an edge back would close a cycle.
import { toolStart, toolResult } from "./toolEvent.js";

// Every path the item touched. Codex reports a file_change as {changes:[{path}]}, as a
// bare path/paths field, or (in the rollout) as `changes` keyed by path. One item can
// carry several files, and the client needs them all to hide the row for each file it
// shows a diff card for.
export function changePaths(item) {
  if (Array.isArray(item?.changes)) return item.changes.map((c) => c.path).filter(Boolean);
  if (item?.changes) return Object.keys(item.changes);
  if (Array.isArray(item?.paths)) return item.paths;
  return item?.path ? [item.path] : [];
}

// The exec stream's item names the changed files but carries no patch, so the text comes
// from the rollout the CLI wrote beside it (`recorded`, keyed by path). Only the changed
// files are returned: a card with nothing in it would still hide the tool row that could
// have said something, and an ephemeral run has no rollout to read at all.
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
    // An add or a delete has no patch, only the whole file — and `content` is the file in
    // BOTH cases: the new text for an add, the removed text for a delete. Which way it
    // reads is the kind, so a delete is signed here rather than shown as an addition.
    const body = raw ? "" : (change.content || rec.content || "");
    const patch = body ? body.replace(/\n$/, "").split("\n").map((l) => `${kind === "delete" ? "-" : "+"}${l}`).join("\n") : raw;
    if (patch) out.push({ file, patch, content: "" });
  }
  return out;
}

// Item type → the category the client sees. The two sources spell the same item
// differently: the live `exec --json` stream writes the lower-case name (its own tests
// record `collab_tool_call`, `todo_list`, `command_execution`), the rollout writes the
// PascalCase one. Both are listed, so the mapping is the same object either way — that
// is the whole point of this file.
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
  // Code review, which the rollout writes in PascalCase and the live stream in camelCase.
  // The tool name is the CATEGORY (not a normal name) so both spellings land on the review
  // card — the client maps `enteredReviewMode`/`EnteredReviewMode` to it in the registry.
  EnteredReviewMode: "enteredReviewMode",
  enteredReviewMode: "enteredReviewMode",
  ExitedReviewMode: "exitedReviewMode",
  exitedReviewMode: "exitedReviewMode"
});

// The name the client sees for one command. Codex runs EVERY built-in through one shell
// tool — a read is `cat`, a listing is `ls`, a patch is `apply_patch` piped to the
// binary — so every item arrived as the same row reading "command" and the session's
// reads, searches and patches were indistinguishable on screen. The CLI already knows
// which is which: it tags the command itself (`parsed_cmd`), one entry per call — 136
// reads, 68 searches, 35 listings across the rollouts on this machine. Read that tag and
// the row names what actually happened; without it the row falls back to "command",
// which is also where the tag's own `unknown` lands.
//
// The tag is only ever a SUFFIX here. The row's category stays "command" so it keeps its
// shell card and its bash icon, and so the transcript reader still pairs an item with the
// `exec_command` call beside it — that pairing is by category, and a renamed item would
// fall out of it and draw a second card for one call.
const PARSED_NAMES = Object.freeze({ read: "read", search: "search", list_files: "list_files" });

export function isCodexToolItem(type) {
  return Boolean(ITEM_CATEGORY[type]);
}

/** True for a file_change in either spelling — the live stream writes the lower-case one. */
export function isCodexFileChange(item) {
  return ITEM_CATEGORY[item?.type] === "file_change";
}

/**
 * A rollout payload — `item_completed`'s envelope, a live `item.*` event, or a bare item
 * — as the events one tool call produces: its card, its result, and any diff cards.
 *
 * `recorded` is the patch store `readCodexFileChanges` returns, keyed by path. The
 * rollout's own FileChange carries the same content, so a reader that has the record
 * needs no second read; the live stream carries none and passes the store in.
 */
export function codexItemEvents(payload, recorded = null) {
  const item = payload?.item || payload;
  const type = item?.type;
  const tool = ITEM_CATEGORY[type];
  if (!tool) return [];

  // What the card prints beside its name. Codex hands a command over as argv — the live
  // stream as a string, the rollout as an array — and the card wants one line, so an
  // array rejoins the way a shell would have taken it. Every field is read in both
  // spellings for the same reason the item names are.
  const cmd = item.command ?? item.command_line;
  const parsed = tool === "command" ? parsedCall(item) : null;
  const input =
    // The raw argv is the fallback, not the default: it carries the login-shell wrapper.
    tool === "command" ? { ...parsed, command: parsed.command || commandLine(cmd) }
    : tool === "file_change" ? changeInput(item)
    : tool === "mcp_tool_call" ? { server: item.server, ...(item.arguments || item.input || {}) }
    // Only `spawn_agent` carries a brief worth showing; the calls that steer an agent
    // that already exists announce an id and nothing else.
    : tool === "collab_tool_call" ? (item.prompt ? { subagent_type: item.tool, prompt: item.prompt } : {})
    : tool === "todo_list" ? { todos: item.items || item.todos || [] }
    // An image it looked at: a READ, and the path is the whole content of the call.
    : tool === "view_image" ? { path: item.path || "", file_path: item.path || "" }
    // A review, which the CLI states as what it is reviewing — the TUI prints this hint.
    : tool === "enteredReviewMode" || tool === "exitedReviewMode"
      ? { review: item.user_facing_hint || item.review || reviewTarget(item.target) }
    : { path: item.path || "" };

  // The name is the item's own tool name where it has one (an MCP call, a spawned agent),
  // and the category otherwise — which for a command is the CLI's own read of what the
  // command was.
  const name = item.tool || parsed?.name || tool;

  // Codex opens a tool with one event and closes it with another. The live stream says
  // which by its envelope (`item.started` / `item.completed`, and the item carries no
  // status of its own); the rollout has only the completed item and says so on the item.
  // Three ways the two doors say "this item is over": the live stream passes a `status`
  // argument, an item may carry its own `status`, and the ROLLOUT wraps it in an
  // `item_completed` envelope with neither. Reading only the first two left every item
  // type that has no `status` field (`imageView`, the review pair, `todo_list`) with its
  // `tool_start` and no `tool_result` — a card that never closes on a reopened chat.
  const done = payload?.status === "completed" || payload?.type === "item_completed" || item.status === "completed";
  const events = [toolStart({ id: item.id, name, input })];
  if (!done) return events;

  if (tool === "command") {
    const output = item.aggregated_output ?? item.stdout ?? "";
    // A failing command still reports "completed"; the exit code is what says it failed.
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
    // A spawned agent's tool calls run in its own thread and never appear on this stream,
    // so there are no children to nest — the card shows the agent and the brief.
    // `agents_states` is the CLI's own read on how it went: an errored one (no
    // credentials, say) carries `message`, while a healthy one is a bare status string —
    // a failure the summary row would otherwise hide.
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

  // Nothing to say when there is no output on this record: the card is left running,
  // which is the truth for a rollout cut mid-tool — and the next hydrate reads it whole.
  // web_search's only text is the query it ran.
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

/**
 * What a review is looking at, as the CLI states it: a tagged union from the rollout
 * (`{type:"uncommittedChanges"}`, a base branch, a commit). The card wants a phrase, and
 * the tag is the phrase — `uncommittedChanges` is the only variant seen on this machine
 * (one run), so the rest fall back to whatever string the record carries.
 */
function reviewTarget(target) {
  if (!target || typeof target !== "object") return "";
  const type = target.type || "";
  if (type === "uncommittedChanges") return "uncommitted changes";
  return target.branch || target.commit || target.sha || type || "";
}

// The command line the card prints. Codex runs every command through a login shell —
// `/bin/bash -lc 'cat a.txt'` on POSIX, `powershell.exe -Command …` or `cmd.exe /d /s /c …`
// on Windows — and showing that wrapper wastes the row and differs per OS. It does NOT
// need unwrapping here: the CLI already hands the clean text over on `parsed_cmd[].cmd`,
// which is the same command with the shell stripped, whatever the platform. One entry per
// command in the call, so a compound line (`a; b`) still prints whole.
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

// A file_change names its files; `changePaths` reads all three spellings, and the card
// needs the first to offer "open in editor" plus the rest to hide its own row.
function changeInput(item) {
  const paths = changePaths(item);
  return { file_path: paths[0] || "", path: paths[0] || "", paths };
}

// An MCP result arrives as content parts; a plain string is already the text.
function textOf(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((c) => c?.text || "").join("");
  return output ? JSON.stringify(output) : "";
}

function errorText(output) {
  return textOf(output) || "Codex reported this tool call as failed.";
}
