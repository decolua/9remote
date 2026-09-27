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
// Input shapes verified against 1.18.31's own schemas (tool/edit.ts, tool/write.ts, tool/apply-patch.ts):
// edit {filePath, oldString, newString}, write {filePath, content}, apply_patch {patchText}.
const DIFF_TOOLS = new Set(["edit", "write", "apply_patch", "patch"]);

// Exported for the serve-bus parser: the v2 write tool names its target `path`
// (measured on the bus), the CLI's own run mode names it `filePath` — read both.
export function diffFor(name, input = {}) {
  if (name === "apply_patch" || name === "patch") {
    const patchText = String(input.patchText || input.patch || "").trim();
    if (!patchText) return null;
    const fileMatches = [...patchText.matchAll(/\*\*\*\s*(?:Update|Add|Delete)\s*File:\s*([^\n\r]+)/gi)];
    if (fileMatches.length > 1) {
      const hunks = [];
      for (let i = 0; i < fileMatches.length; i++) {
        const file = fileMatches[i][1].trim();
        const start = fileMatches[i].index;
        const end = i + 1 < fileMatches.length ? fileMatches[i + 1].index : patchText.length;
        const section = patchText.slice(start, end);
        const lines = section.split("\n").filter((l) => !l.startsWith("***"));
        hunks.push({ file, name, patch: lines.join("\n"), content: "" });
      }
      return hunks;
    }
    const match = fileMatches[0];
    const file = match ? match[1].trim() : (input.filePath || input.file || input.path || "");
    if (!file) return null;
    const lines = patchText.split("\n")
      .filter((l) => !l.startsWith("***"));
    return { file, name, patch: lines.join("\n"), content: "" };
  }

  const file = input.filePath || input.file || input.path || "";
  if (!file) return null;
  // No content, no card: an empty diff hiding the tool row is worse than the row.
  if (name === "write") return input.content ? { file, name, patch: "", content: String(input.content) } : null;
  const oldStr = input.oldString || input.old_string;
  const newStr = input.newString || input.new_string;
  if (!oldStr && !newStr) return null;
  // A trailing newline would add an empty +/- line that reads as a real change.
  const lines = [];
  const add = (text, sign) => {
    const body = String(text ?? "").replace(/\n$/, "");
    if (body) lines.push(...body.split("\n").map((l) => `${sign}${l}`));
  };
  add(oldStr, "-");
  add(newStr, "+");
  return { file, name, patch: lines.join("\n"), content: "" };
}

// opencode's read wraps its payload for the model (XML-ish tags around the
// content); the pane's file card wants the bare content, claude-style. Inner
// `</content>` strings truncate — ponytail: files that embed the tag are rare.
const READ_CONTENT_RE = /<content>\n?([\s\S]*?)\n?<\/content>/;

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
  let output = state.output ?? "";
  if (name === "read") {
    const bare = READ_CONTENT_RE.exec(String(output));
    if (bare) output = bare[1];
  }
  // A failing shell command still reports "completed" — the exit code is what says it
  // failed, so a non-zero one must surface as an error card. An error with no exit
  // (a read of a missing file) says itself; "(exit undefined)" says nothing.
  const exit = state.metadata?.exit;
  const failed = state.status === "error" || (typeof exit === "number" && exit !== 0);
  // A rejected question tool arrives as status "error" with NO text — Boolean("") then
  // flips toolResult into a "done" with empty output and the row reads "Running…" forever.
  const error = [String(output), exit != null ? `(exit ${exit})` : ""].filter(Boolean).join("\n")
    || (name === "question" ? "User skipped this request" : "Tool failed.");
  events.push(
    failed
      ? toolResult({ id, name, error })
      : toolResult({ id, name, output: String(output) })
  );
  // Only a change that LANDED is a diff — a rejected edit stays the tool row it is
  // (same rule as claude's adapter, which reads the diff off the result).
  if (!failed && DIFF_TOOLS.has(name)) {
    const diff = diffFor(name, state.input || part?.input || {});
    if (diff) {
      if (Array.isArray(diff)) for (const d of diff) events.push({ event: "diff", data: d });
      else events.push({ event: "diff", data: diff });
    }
  }
  return events;
}
