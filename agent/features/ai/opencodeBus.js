// The opencode serve event bus (v2, GET /api/event) → the pane's event vocabulary.
//
// The bus is the one the CLI's own TUI renders from (session.next.*), so the pane
// becomes a re-render of the TUI the way it already is for claude: text and
// reasoning stream as deltas, a tool is announced while its INPUT is still
// streaming, and the harness's own records travel whole under their own names.
//
// There is no end-of-turn event on this bus — the runner's loop just stops (see
// .source/opencode packages/core/src/session/runner/llm.ts). The signal is the
// LAST step's finish reason: the CLI's own closed set is stop | length |
// tool-calls | content-filter | error | unknown (packages/llm/src/schema/ids.ts),
// and only "tool-calls" means another step follows. Everything else ends the turn.
import { diffFor } from "./opencodePart.js";

// Records whose whole point is bookkeeping between the harness and itself: the
// pane already drew the prompt when it was sent, part edges carry no payload the
// pane does not already have from the deltas, and the context reminder is the
// model's, not the reader's. Dropped here, not passed through.
const SILENT_TYPES = new Set([
  "session.next.prompt.admitted",
  "session.next.prompted",
  "session.next.step.started",
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.ended",
  "session.next.tool.input.delta",
  "session.next.tool.progress",
  "session.next.context.updated",
  "server.connected",
  "server.heartbeat",
]);

// A finish that means the model called a tool and another step is coming.
const TOOL_CALLS = "tool-calls";

/**
 * One bus parser per chat. `stats` is the adapter's own object, mutated in place
 * so the door metadata and tests keep reading the same reference the old
 * per-turn CLI did.
 */
export function createOpencodeBusParser({ onEvent, stats = {} }) {
  // Tool name and parsed input by callID: input.started/called carry them, the
  // settling events reference the call by id alone.
  const names = new Map();
  const inputs = new Map();

  const addTokens = (tokens) => {
    stats.inputTokens = (stats.inputTokens || 0) + (tokens.input || 0);
    stats.outputTokens = (stats.outputTokens || 0) + (tokens.output || 0);
    stats.reasoningTokens = (stats.reasoningTokens || 0) + (tokens.reasoning || 0);
    // Each step resends the growing conversation, so the LAST step's input is
    // what the window currently holds — the sum would bill it repeatedly.
    stats.contextTokens = tokens.input || 0;
  };

  const toolName = (data, fallback = "tool") => data.name || data.tool || names.get(data.callID) || fallback;

  function handle(envelope) {
    const type = envelope?.type || "";
    if (!type.startsWith("session.next.")) return;
    if (SILENT_TYPES.has(type)) return;
    const data = envelope.data || {};

    if (type === "session.next.text.delta") {
      if (data.delta) onEvent("delta", { text: data.delta });
      return;
    }
    if (type === "session.next.reasoning.delta") {
      if (data.delta) onEvent("thinking", { text: data.delta });
      return;
    }

    if (type === "session.next.tool.input.started") {
      names.set(data.callID, data.name);
      onEvent("tool_start", { id: data.callID, name: data.name || "tool", input: {}, status: "running" });
      return;
    }
    if (type === "session.next.tool.input.ended") {
      // The whole input as one JSON string. `called` repeats it parsed, but it can
      // race the pane's first paint; announcing the parsed form here too is the
      // upsert that fills the card the moment the harness has the args.
      let input = {};
      try { input = JSON.parse(data.text || "{}"); } catch { input = {}; }
      inputs.set(data.callID, input);
      onEvent("tool_start", { id: data.callID, name: toolName(data), input, status: "running" });
      return;
    }
    if (type === "session.next.tool.called") {
      names.set(data.callID, data.tool);
      if (data.input && Object.keys(data.input).length) inputs.set(data.callID, data.input);
      onEvent("tool_start", { id: data.callID, name: toolName(data), input: data.input || {}, status: "running" });
      return;
    }
    if (type === "session.next.tool.success") {
      const name = toolName(data);
      // The bus has no flat output string: the harness reports what the tool
      // said as content blocks, and the structured record as metadata.
      const output = (data.content || []).map((c) => c?.text || "").filter(Boolean).join("\n")
        || (data.result != null ? String(data.result) : "");
      onEvent("tool_result", { id: data.callID, name, output, status: "done" });
      // Only a change that LANDED is a diff — the same rule as every other door.
      const diff = diffFor(name, inputs.get(data.callID) || {});
      if (diff) onEvent("diff", diff);
      return;
    }
    if (type === "session.next.tool.failed") {
      onEvent("tool_result", { id: data.callID, name: toolName(data), error: data.error?.message || "Tool failed.", status: "error" });
      return;
    }

    if (type === "session.next.step.ended") {
      if (data.tokens) {
        addTokens(data.tokens);
        onEvent("stats", { stats });
      }
      if (data.finish !== TOOL_CALLS) {
        stats.totalTurns = (stats.totalTurns || 0) + 1;
        onEvent("turn_complete", { stats, result: "", isError: false, subtype: "" });
      }
      return;
    }
    if (type === "session.next.step.failed") {
      onEvent("error", { message: data.error?.message || "The turn failed." });
      return;
    }

    // Nothing above claimed it, and the pane is a re-render of this CLI's own
    // TUI — so the record travels whole, under the harness's own name, for
    // whatever the pane learns to draw next.
    onEvent("cli_event", { type, subtype: "", record: data });
  }

  return { handle };
}
