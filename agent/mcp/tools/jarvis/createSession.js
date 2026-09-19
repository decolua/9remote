// create_session — Jarvis's hands for standing up a new worker. The PTY is spawned
// via the daemon, REGISTERED into the agent's session map (so the sidebar list and
// workspace pinning see it — a bare daemon spawn is invisible to every list), then
// the engine command is typed into it, exactly as the user would from the modal.
import { createSession as createPtySession, sendInput } from "../../../features/terminal/ptyDaemonClient.js";
import { registerManagedSession } from "../../../features/terminal/terminalSocket.js";

const ENGINES = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  bash: null
};
// The skip-permissions flag per engine, where one is publicly known. Codex and
// opencode gate this through their own config/profiles, not argv (ponytail).
const YOLO_FLAGS = { claude: "--dangerously-skip-permissions" };
// A branch rides in as a typed `git checkout -b` before the engine starts; a bare
// name (never a shell fragment) is the only shape accepted.
const BRANCH_RE = /^[\w./-]+$/;

export function makeCreateSessionTool(deps = {
  createPtySession: async ({ name, cwd }) => createPtySession(name, 120, 32, null, `jarvis-w-${Date.now()}`, cwd),
  registerManagedSession,
  sendInput
}) {
  return {
    name: "create_session",
    description:
      "Open a new terminal session and optionally launch an AI agent in it. Use it to add a worker " +
      "when no idle session fits the task. Pass `workspace` (a workspacePath from list_fleet) so the " +
      "tab appears in that workspace's list. The new session shows in the user's terminal UI.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["claude", "codex", "opencode", "bash"], description: "Agent CLI to launch; bash opens a plain shell" },
        cwd: { type: "string", description: "Working directory to start in" },
        workspace: { type: "string", description: "Workspace path the tab belongs to (from list_fleet's workspacePath)" },
        branch: { type: "string", description: "Git branch to create and check out before launching" },
        yolo: { type: "boolean", description: "Run without approval prompts, where the engine's CLI allows it" },
        title: { type: "string", description: "Tab name shown to the user" }
      },
      required: ["engine"]
    },
    async run({ engine, cwd, workspace, branch, yolo, title } = {}) {
      const command = ENGINES[engine];
      if (command === undefined) return { error: `unknown engine: ${engine}` };
      // Validate everything BEFORE spawning — a bad branch found after would leave
      // an empty tab behind with no engine in it.
      if (branch && !BRANCH_RE.test(branch)) return { error: "invalid branch name" };

      const name = title || `Jarvis ${engine}`;
      const startCwd = cwd || workspace || null;
      const res = await deps.createPtySession({ name, cwd: startCwd });
      if (!res?.success) return { error: res?.error || "failed to create session" };

      // The step that makes it a LISTED session, not just a daemon PTY. The cwd
      // rides along as the pin fallback: the conductor often names only where the
      // work happens, and the deepest workspace containing that path is the tab's.
      deps.registerManagedSession({
        sessionId: res.sessionId,
        name,
        cwd: res.cwd || startCwd,
        workspacePath: workspace || startCwd || null,
        shellId: res.shellId || null,
        shellLabel: res.shellLabel || null
      });

      if (branch) {
        deps.sendInput(res.sessionId, `git checkout -b ${branch}\n`);
      }
      if (command) {
        const launch = yolo && YOLO_FLAGS[engine] ? `${command} ${YOLO_FLAGS[engine]}` : command;
        deps.sendInput(res.sessionId, `${launch}\n`);
      }
      return { sessionId: res.sessionId, engine, cwd: res.cwd || startCwd, workspace: workspace || null };
    }
  };
}

export default makeCreateSessionTool();
