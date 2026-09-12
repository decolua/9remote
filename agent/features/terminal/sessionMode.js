// Switching one terminal between the agent CLI running in it and the chat UI.
// The host owns the switch: it knows the conversation and can move the daemon's AI
// session, neither of which a client may decide on its own.
import * as daemonClient from "./ptyDaemonClient.js";
import { resumeCommand } from "./agentHistory.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import {
  getConversation, getSessionAgent, setSessionAgent, setConversationId
} from "./statusManager.js";
import { MODE, engineFromAgent } from "./conversationModes.js";

const logger = createLogger("sessionMode");
const RESUME_EXIT_MS = 2000; // wait for the CLI to exit before relaunching the conversation
// Engines whose CLI is daemon-owned, so the chat UI can drive it. Must list exactly
// the ids the web registry gives a `ui:` entry — an engine missing here is refused a
// switch, one listed without a registry entry renders as a plain terminal.
// codex is listed for the surface bookkeeping (setSessionMode on an already-UI
// session, re-recording a lost mode); the daemon-driven branch itself is claude-only.
const UI_ENGINES = new Set(["claude", "codex"]);
const DAEMON_ENGINE = "claude";

// The conversation this terminal holds, or the one the daemon is actually running
// when status has not caught up yet. A terminal switched into the UI records its
// conversation a beat after the click, so status is not the only place to look.
// Only claude reaches the daemon branch below — createAiSession refuses every other
// engine — so that fallback names claude rather than reading a field that is a
// constant there, and the caller still gates on the surface before using it.
async function resolveConversation(sessionId) {
  const conv = getConversation(sessionId);
  if (conv?.id) return conv;
  if (!daemonClient.isConnected()) return null;
  const joined = await daemonClient.joinAiSession(sessionId).catch(() => null);
  const id = joined?.session?.cliSessionId;
  return id ? { agent: engineFromAgent(getSessionAgent(sessionId)) || DAEMON_ENGINE, id } : null;
}

export async function setSessionMode(sessionId, mode, { sessions, io } = {}) {
  const session = sessions?.get(sessionId);
  if (!session) return { success: false, error: "Session not found" };
  if (mode !== MODE.UI && mode !== MODE.TERMINAL) return { success: false, error: "Invalid mode" };
  const conv = await resolveConversation(sessionId);
  if (!conv) return { success: false, error: "No conversation in this terminal" };

  const current = engineFromAgent(getSessionAgent(sessionId) || conv.agent);
  if (!UI_ENGINES.has(current)) return { success: false, error: `${current} has no chat UI` };

  const agentId = mode === MODE.UI ? `${current}-ui` : current;
  // Already on this surface. The conversation is re-recorded anyway: a switch whose
  // record was lost would otherwise leave the pane on an empty chat for good.
  if (conv.agent.endsWith("-ui") === (mode === MODE.UI)) {
    logger.debug(`session ${sessionId} already ${mode}, re-recording ${conv.id}`);
    setConversationId(sessionId, agentId, conv.id, "resume");
    return { success: true };
  }

  logger.info(`session ${sessionId}: ${mode} ← ${conv.agent} ${conv.id}`);
  // Set the surface first: it clears any conversation belonging to another CLI, and
  // the re-record below is what restores it — under the surface now running it.
  setSessionAgent(sessionId, agentId);
  session.agent = agentId;
  if (mode === MODE.TERMINAL) leaveUi(sessionId, session, conv);
  // Records the conversation against the new surface, so the history row lights up
  // and reopening it lands on the same one.
  setConversationId(sessionId, agentId, conv.id, "resume");
  // Broadcast, not io.emit: clients listen on the per-connection bus, which the
  // raw socket would bypass entirely.
  broadcast(io, "sessionAgentChanged", { sessionId, agent: agentId });
  return { success: true };
}

function leaveUi(sessionId, session, conv) {
  // Leaving the UI would strand a CLI process on the host holding this conversation
  // while a second one resumes it.
  if (daemonClient.isConnected()) daemonClient.destroyAiSession(sessionId).catch(() => {});
  // Same exit-and-resume a layout change already does: the TUI hard-wraps at launch
  // width, so the only true re-render is the CLI's own resume line. This is a
  // keystroke into a live shell, so whether the terminal is up is asked of the host,
  // not assumed — an unjoined terminal has nothing listening.
  if (!session.daemon || !daemonClient.isConnected()) return;
  // conv.agent still names the surface ("codex-ui") when the mode came back from a
  // record; resumeCommand only knows engine ids, and would answer null.
  const line = resumeCommand(engineFromAgent(conv.agent), conv.id, true);
  if (!line) return;
  daemonClient.sendInput(sessionId, "\x03\x03"); // Ctrl+C x2 — exit the running TUI
  setTimeout(() => daemonClient.sendInput(sessionId, `${line}\r`), RESUME_EXIT_MS);
  logger.debug(`session ${sessionId} → terminal (${conv.agent} ${conv.id})`);
}
