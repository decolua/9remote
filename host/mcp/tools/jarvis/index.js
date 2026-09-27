// Every Jarvis coordinator tool. Same module contract as ../index.js — a factory
// for tests, a default instance with real deps for the server. The base manifest
// never includes these; mcpServer gates them on the caller being the Jarvis session.
import listFleet, { makeListFleetTool } from "./listFleet.js";
import createSession, { makeCreateSessionTool } from "./createSession.js";
import dispatchPrompt, { makeDispatchPromptTool } from "./dispatchPrompt.js";
import resolveGate, { makeResolveGateTool } from "./resolveGate.js";
import manageKanban, { makeManageKanbanTool } from "./manageKanban.js";
import readTerminal, { makeReadTerminalTool } from "./readTerminal.js";
import closeSession, { makeCloseSessionTool } from "./closeSession.js";

export const JARVIS_TOOLS = [listFleet, createSession, dispatchPrompt, resolveGate, manageKanban, readTerminal, closeSession];
export const JARVIS_TOOL_NAMES = new Set(JARVIS_TOOLS.map((tool) => tool.name));
export const jarvisToolManifest = () =>
  JARVIS_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

export { makeListFleetTool, makeCreateSessionTool, makeDispatchPromptTool, makeResolveGateTool, makeManageKanbanTool, makeReadTerminalTool, makeCloseSessionTool };
