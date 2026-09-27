// How each past conversation was last opened: the chat UI ("ui") or the agent CLI
// in a terminal ("terminal"). Keyed by "<agent>:<conversationId>" rather than by
// session, so the answer outlives the terminal that held it and a history row can
// reopen the conversation the same way it was left.
import fs from "fs";
import path from "path";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("conversationModes");
const MODES_FILE = path.join(PATHS.STATE, "conversationModes.json");

export const MODE = Object.freeze({ UI: "ui", TERMINAL: "terminal" });

let modes = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(MODES_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

const keyOf = (agentId, conversationId) => `${agentId}:${conversationId}`;

// The UI runs the base engine's CLI underneath, so it is not a mode of its own.
export const modeFromAgent = (agentId) => (agentId?.endsWith("-ui") ? MODE.UI : MODE.TERMINAL);
export const engineFromAgent = (agentId) => (agentId?.endsWith("-ui") ? agentId.slice(0, -3) : agentId);

export function getConversationMode(agentId, conversationId) {
  if (!agentId || !conversationId) return null;
  return modes[keyOf(engineFromAgent(agentId), conversationId)] || null;
}

export function setConversationMode(agentId, conversationId, mode) {
  if (!agentId || !conversationId || !mode) return;
  const key = keyOf(engineFromAgent(agentId), conversationId);
  if (modes[key] === mode) return;
  modes[key] = mode;
  try {
    fs.mkdirSync(path.dirname(MODES_FILE), { recursive: true });
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2), "utf8");
  } catch (e) {
    logger.warn(`persist failed: ${e.message}`);
  }
}
