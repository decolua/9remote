// Every MCP tool the agent exposes. To add one: drop a module here that default-exports
// { name, description, inputSchema, run }, then list it below — nothing else changes.
import openArtifact from "./openArtifact.js";
import reportTask from "./reportTask.js";
import { JARVIS_TOOLS } from "./jarvis/index.js";

export const TOOLS = [openArtifact, reportTask];

// Callable set includes the Jarvis tools (gated per-caller in mcpServer); the base
// manifest below deliberately does not — a worker session must not even see them.
export const TOOL_BY_NAME = new Map([...TOOLS, ...JARVIS_TOOLS].map((tool) => [tool.name, tool]));

// The wire shape MCP's tools/list expects — `run` is ours, not the protocol's.
export const toolManifest = () =>
  TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
