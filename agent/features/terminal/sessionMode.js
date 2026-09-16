// Switching one terminal between the agent CLI running in it and the chat UI.
// The host owns the switch: it knows the conversation and can move the daemon's AI
// session, neither of which a client may decide on its own.
import * as daemonClient from "./ptyDaemonClient.js";
import { globalAiManager } from "../ai/aiManager.js";
import { resumeCommand } from "./agentHistory.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import {
  getConversation, getSessionAgent, setSessionAgent, setConversationId
} from "./statusManager.js";
import { MODE, engineFromAgent } from "./conversationModes.js";

const logger = createLogger("sessionMode");
// How long a CLI is given to exit before the other surface takes the conversation over:
// in one direction the resume line is typed into the shell, in the other the chat's own
// process binds the same conversation. Both want the old CLI gone first.
const CLI_EXIT_MS = 2000;
// Engines whose CLI is daemon-owned, so the chat UI can drive it. Must list exactly
// the ids the web registry gives a `ui:` entry — an engine missing here is refused a
// switch, one listed without a registry entry renders as a plain terminal.
// codex is listed for the surface bookkeeping (setSessionMode on an already-UI
// session, re-recording a lost mode); the daemon-driven branch itself is claude-only.
const UI_ENGINES = new Set(["claude", "codex"]);
// Whose id a session carries when status has not recorded the surface yet: only the
// chat engines resolve here, and claude is the one every host has.
const FALLBACK_ENGINE = "claude";

// The conversation this terminal holds, or the one its live chat session is actually
// running when status has not caught up yet. A terminal switched into the UI records
// its conversation a beat after the click, so status is not the only place to look.
function resolveConversation(sessionId) {
  const conv = getConversation(sessionId);
  if (conv?.id) return conv;
  const id = globalAiManager.getSession(sessionId)?.cliSessionId;
  return id ? { agent: engineFromAgent(getSessionAgent(sessionId)) || FALLBACK_ENGINE, id } : null;
}

export async function setSessionMode(sessionId, mode, { sessions, io } = {}) {
  const session = sessions?.get(sessionId);
  if (!session) return { success: false, error: "Session not found" };
  if (mode !== MODE.UI && mode !== MODE.TERMINAL) return { success: false, error: "Invalid mode" };
  const conv = resolveConversation(sessionId);
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
  // The CLI on the surface being left has to go: it holds this conversation, and the
  // surface coming up resumes the same one. Two CLIs on one conversation write the same
  // transcript twice.
  if (mode === MODE.UI) enterUi(sessionId, session);
  else leaveUi(sessionId, session, conv);
  // Records the conversation against the new surface, so the history row lights up
  // and reopening it lands on the same one.
  setConversationId(sessionId, agentId, conv.id, "resume");
  // Broadcast, not io.emit: clients listen on the per-connection bus, which the
  // raw socket would bypass entirely.
  broadcast(io, "sessionAgentChanged", { sessionId, agent: agentId });
  return { success: true };
}

// Ctrl+C x2 into the PTY — how the TUI exits. Only worth sending to a terminal the
// daemon is actually running and a client has joined: an unjoined one has nothing
// listening, and a non-daemon session has no PTY behind it.
function exitTui(sessionId, session) {
  if (!session.daemon || !daemonClient.isConnected()) return false;
  daemonClient.sendInput(sessionId, "\x03\x03");
  return true;
}

// The chat's own CLI, which the daemon runs as a managed process. Stopping it is a
// route on the daemon, not on this agent: the process outlives an agent restart, while
// globalAiManager's registry does not — a stale map makes destroySession a silent no-op
// and leaves the CLI holding the conversation. procId is the session id (aiSession).
async function stopChatCli(sessionId) {
  globalAiManager.destroySession(sessionId);
  if (!daemonClient.isConnected()) return;
  await daemonClient.procStop(sessionId).catch(() => {});
}

// Terminal → chat UI. The TUI in the PTY holds the conversation the chat is about to
// resume, so it exits first; the shell, the tab and the session itself all stay.
function enterUi(sessionId, session) {
  stopChatCli(sessionId);
  if (exitTui(sessionId, session)) logger.debug(`session ${sessionId} → ui, TUI exiting`);
}

function leaveUi(sessionId, session, conv) {
  // Leaving the UI would strand a CLI process on the host holding this conversation
  // while a second one resumes it.
  stopChatCli(sessionId);
  // conv.agent still names the surface ("codex-ui") when the mode came back from a
  // record; resumeCommand only knows engine ids, and would answer null.
  const line = resumeCommand(engineFromAgent(conv.agent), conv.id, true);
  // Nothing to relaunch the conversation with, so the TUI stays where it is — a bare
  // shell with no way back is worse than a CLI the next switch can move.
  if (!line) return;
  // Same exit-and-resume a layout change already does: the TUI hard-wraps at launch
  // width, so the only true re-render is the CLI's own resume line. This is a
  // keystroke into a live shell, so whether the terminal is up is asked of the host,
  // not assumed — an unjoined terminal has nothing listening.
  if (!exitTui(sessionId, session)) return;
  setTimeout(() => daemonClient.sendInput(sessionId, `${line}\r`), CLI_EXIT_MS);
  logger.debug(`session ${sessionId} → terminal (${conv.agent} ${conv.id})`);
}
