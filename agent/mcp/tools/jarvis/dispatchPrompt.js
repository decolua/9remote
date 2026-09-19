// dispatch_prompt — hand work to one session. An AI session gets the prompt through
// its own turn pipeline; a plain terminal gets it typed, the way the user would.
import { globalAiManager } from "../../../features/ai/aiManager.js";
import { sendInput } from "../../../features/terminal/ptyDaemonClient.js";

export function makeDispatchPromptTool(deps = {
  getAiSession: (id) => globalAiManager.getSession(id),
  sendInput
}) {
  return {
    name: "dispatch_prompt",
    description:
      "Send a task/prompt to a session. Prefer an idle session whose cwd/branch matches the work. " +
      "For AI sessions the prompt goes through their chat; for plain terminals it is typed as a command.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Target session id (from list_fleet)" },
        prompt: { type: "string", description: "The task to run" }
      },
      required: ["sessionId", "prompt"]
    },
    async run({ sessionId, prompt } = {}) {
      const text = String(prompt || "").trim();
      if (!sessionId || !text) return { error: "sessionId and prompt are required" };

      const ai = deps.getAiSession(sessionId);
      if (ai) {
        // sendPrompt refuses a busy turn by emitting an event the caller of THIS
        // tool never sees — check the turn first so the conductor is told, not lied to.
        if (ai.isTurnRunning) return { error: "session's turn is still running — wait, stop it, or dispatch to an idle session" };
        ai.sendPrompt(text);
        return { ok: true, via: "ai" };
      }
      deps.sendInput(sessionId, `${text}\n`);
      return { ok: true, via: "pty" };
    }
  };
}

export default makeDispatchPromptTool();
