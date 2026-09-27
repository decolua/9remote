// close_session — the conductor's broom. Workers it spawned live in the daemon
// and survive everything; without this the fleet only ever grows. Teardown rides
// the SAME destroy path the UI's tab-close uses (PTY kill + agent maps + persist
// + broadcast), so nothing can drift between the two doors.
import { destroySessionById } from "../../../features/terminal/handlers/SessionHandler.js";

export function makeCloseSessionTool(deps = { destroySession: destroySessionById }) {
  return {
    name: "close_session",
    description:
      "Close a worker session for good — its terminal is killed and the tab disappears from the user's list. " +
      "Use it for workers you spawned once their work is done and reviewed, to free RAM and tokens. " +
      "Ask the user first before closing a session they opened themselves. Never close your own session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The worker session to close (from list_fleet)" }
      },
      required: ["sessionId"]
    },
    async run({ sessionId } = {}, ctx = {}) {
      const id = String(sessionId || "").trim();
      if (!id) return { error: "sessionId is required" };
      // Suicide is not resource management: the conductor closes workers, never itself.
      if (id === ctx?.sessionId) {
        return { error: "refusing to close the coordinator's own session" };
      }
      const closed = await deps.destroySession(id);
      if (!closed) return { error: `no such session: ${id}` };
      return { closed: id };
    }
  };
}

export default makeCloseSessionTool();
