// resolve_gate — the single door for every kind of wait a worker can hit: a
// permission ask, a question, a plan approval. An `answer` routes to the question
// flow; a bare decision routes to the permission flow.
import { globalAiManager } from "../../../features/ai/aiManager.js";

export function makeResolveGateTool(deps = {
  getAiSession: (id) => globalAiManager.getSession(id)
}) {
  return {
    name: "resolve_gate",
    description:
      "Answer a session that is waiting (status needs_input). Give `answer` for a question/choice, " +
      "or `decision` allow/deny for a permission/plan approval. Relay the user's own words — do not " +
      "decide for them unless they asked you to.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session waiting for input" },
        requestId: { type: "string", description: "The pending gate's request id" },
        decision: { type: "string", enum: ["allow", "deny"] },
        answer: { type: "string", description: "Answer text when the gate asks a question" },
        reason: { type: "string", description: "Why, when denying or giving feedback" }
      },
      required: ["sessionId", "requestId"]
    },
    async run({ sessionId, requestId, decision, answer, reason } = {}) {
      if (!sessionId || !requestId) return { error: "sessionId and requestId are required" };
      const ai = deps.getAiSession(sessionId);
      if (!ai) return { error: `no AI session to resolve against: ${sessionId}` };

      if (answer !== undefined && answer !== null && String(answer).trim() !== "") {
        if (!ai.resolveQuestion(requestId, answer)) return { error: "gate is stale — the session moved on" };
        return { ok: true, kind: "question" };
      }
      const behavior = decision === "allow" ? "allow" : "deny";
      if (!ai.resolvePermission(requestId, behavior, reason || "")) return { error: "gate is stale — the session moved on" };
      return { ok: true, kind: "permission", behavior };
    }
  };
}

export default makeResolveGateTool();
