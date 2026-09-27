// manage_kanban — the board the user watches. One action per call; the store
// behind applyAndBroadcast owns load→apply→persist→push (and the single-flight
// queue), so this tool and the socket door cannot drift apart.
import { applyAndBroadcast } from "../../../features/jarvis/jarvisState.js";

export function makeManageKanbanTool(deps = { applyAction: applyAndBroadcast }) {
  return {
    name: "manage_kanban",
    description:
      "Create, update, move or delete a task on the kanban board the user watches. Columns: " +
      "todo | in_progress | needs_input | done. Attach sessionId/branch so the card names its worker, " +
      "and `workspace` (the workspace path the task belongs to) so it shows on that workspace's board — " +
      "omit it only for genuinely machine-wide work. " +
      "Actions: {type:'create',title,sessionId?,branch?,workspace?,notes?} | {type:'update',taskId,patch} | " +
      "{type:'move',taskId,status} | {type:'delete',taskId}.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["create", "update", "move", "delete"] },
        title: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "needs_input", "done"] },
        sessionId: { type: "string" },
        branch: { type: "string" },
        workspace: { type: "string", description: "Workspace path this task belongs to (from list_fleet's workspacePath)" },
        notes: { type: "string" },
        patch: { type: "object", description: "Fields to merge into the task (summary, notes...)" }
      },
      required: ["type"]
    },
    async run(action = {}, ctx = {}) {
      const { board, error } = await deps.applyAction(action, `mcp:${ctx?.sessionId || "?"}`);
      if (error) return { error };
      return JSON.stringify(board);
    }
  };
}

export default makeManageKanbanTool();
