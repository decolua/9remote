// report_task — the worker's one line back to the board. Any AI CLI in any session
// (terminal tab or chat pane) sees it; the session id comes from the MCP caller
// context, never from the model, so a worker can only ever report for itself.
import { applyAndBroadcast } from "../../features/jarvis/jarvisState.js";
import { KANBAN_STATUSES } from "../../features/jarvis/jarvisKanban.js";

const MAX_SUMMARY_CHARS = 500;

export function makeReportTaskTool(deps = { applyAction: applyAndBroadcast }) {
  return {
    name: "report_task",
    description:
      "Report what you just finished, in one or two sentences. It lands on this session's card on the " +
      "kanban board the user watches, so progress is visible without reading your terminal. Call it when " +
      "a chunk of work completes, and again with status when your own state changes " +
      "(todo | in_progress | needs_input | done). While a turn of yours is actually running, the live " +
      "state wins — the self-report takes effect when you go idle.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "1-2 sentences of what was done or what changed" },
        status: { type: "string", enum: KANBAN_STATUSES, description: "Optional self-reported status; live turn state still wins while running" }
      },
      required: ["summary"]
    },
    async run({ summary, status } = {}, ctx = {}) {
      const clean = String(summary || "").trim().slice(0, MAX_SUMMARY_CHARS);
      if (!clean) return { error: "summary is required" };
      const sessionId = ctx?.sessionId;
      // No caller identity means no card to write — an honest error, not a stray card.
      if (!sessionId) return { error: "no session identity; cannot tell which card is yours" };
      const { error } = await deps.applyAction({ type: "report", sessionId, summary: clean, ...(status ? { status } : {}) });
      if (error) return { error };
      return "reported";
    }
  };
}

export default makeReportTaskTool();
