// One opencode tool part → the wire events it stands for.
//
// Unlike codex, this needs no second spelling: the object the live stream carries
// (`{type:"tool_use", part:{tool, callID, state:{status,input,output}}}`) IS the row the
// CLI stores in its own database — same `tool`, same `callID`, same `state.status`,
// `state.output`, `state.metadata.exit`. So the live adapter and the transcript reader
// call this same function, and a reopened chat shows the calls the live one showed.
//
// Only the wrapper differs: live, the part rides inside the envelope; on disk, the row's
// `data` column is the part itself.
import { toolStart, toolResult } from "./toolEvent.js";

// Edit tools whose input carries the change itself, so the turn draws a diff card
// instead of a bare tool row — the same fold claude's adapter does for Edit/Write.
// Input shapes verified against 1.18.31's own schemas (tool/edit.ts, tool/write.ts):
// edit {filePath, oldString, newString}, write {filePath, content}.
const DIFF_TOOLS = new Set(["edit", "write"]);

// Exported for the serve-bus parser: the v2 write tool names its target `path`
// (measured on the bus), the CLI's own run mode names it `filePath` — read both.
export function diffFor(name, input = {}) {
  const file = input.filePath || input.file || input.path || "";
  if (!file) return null;
  // No content, no card: an empty diff hiding the tool row is worse than the row.
  if (name === "write") return input.content ? { file, name, patch: "", content: String(input.content) } : null;
  if (!input.oldString && !input.newString) return null;
  // A trailing newline would add an empty +/- line that reads as a real change.
  const lines = [];
  const add = (text, sign) => {
    const body = String(text ?? "").replace(/\n$/, "");
    if (body) lines.push(...body.split("\n").map((l) => `${sign}${l}`));
  };
  add(input.oldString, "-");
  add(input.newString, "+");
  return { file, name, patch: lines.join("\n"), content: "" };
}

export function opencodePartEvents(part) {
  const state = part?.state || {};
  const id = part?.callID || part?.id;
  const name = part?.tool || part?.name;
  if (!id || !name) return [];

  // The CLI reports a tool only once it has finished, so the card is announced first —
  // the client drops a tool_result whose id it has never seen.
  const events = [toolStart({ id, name, input: state.input || part?.input || {} })];
  if (state.status !== "completed" && state.status !== "error") return events;

  // A `task` call runs its sub-agent in a separate session (state.metadata.sessionId):
  // those tool calls stream under that id and never reach this one, so the card shows
  // the brief instead of a child count that could only ever read zero.
  const output = state.output ?? "";
  // A failing shell command still reports "completed" — the exit code is what says it
  // failed, so a non-zero one must surface as an error card. An error with no exit
  // (a read of a missing file) says itself; "(exit undefined)" says nothing.
  const exit = state.metadata?.exit;
  const failed = state.status === "error" || (typeof exit === "number" && exit !== 0);
  events.push(
    failed
      ? toolResult({ id, name, error: [String(output), exit != null ? `(exit ${exit})` : ""].filter(Boolean).join("\n") })
      : toolResult({ id, name, output: String(output) })
  );
  // Only a change that LANDED is a diff — a rejected edit stays the tool row it is
  // (same rule as claude's adapter, which reads the diff off the result).
  if (!failed && DIFF_TOOLS.has(name)) {
    const diff = diffFor(name, state.input || part?.input || {});
    if (diff) events.push({ event: "diff", data: diff });
  }
  return events;
}
