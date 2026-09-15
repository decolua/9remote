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
  // failed, so a non-zero one must surface as an error card.
  const exit = state.metadata?.exit;
  const failed = state.status === "error" || (typeof exit === "number" && exit !== 0);
  events.push(
    failed
      ? toolResult({ id, name, error: `${output}\n(exit ${exit})`.trim() })
      : toolResult({ id, name, output: String(output) })
  );
  return events;
}
