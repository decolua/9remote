// list_fleet — Jarvis's eyes. Every open session, its engine, cwd/branch/worktree,
// and the one fact that decides the next move: idle | running | needs_input.
import { fleetSnapshot } from "../../../features/jarvis/fleetRunner.js";

export function makeListFleetTool(deps = { fleetSnapshot }) {
  return {
    name: "list_fleet",
    description:
      "List every open terminal/AI-agent session with its engine, working directory, git branch, " +
      "worktree flag, workspace path (use it as `workspace` for manage_kanban/create_session) and " +
      "status (idle | running | needs_input, including the pending question). " +
      "Call this before assigning work, and whenever the user asks what is going on.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return JSON.stringify(await deps.fleetSnapshot());
    }
  };
}

export default makeListFleetTool();
