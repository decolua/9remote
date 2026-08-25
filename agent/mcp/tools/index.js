// Every MCP tool the agent exposes. To add one: drop a module here that default-exports
// { name, description, inputSchema, run }, then list it below — nothing else changes.
import openArtifact from "./openArtifact.js";

export const TOOLS = [openArtifact];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// The wire shape MCP's tools/list expects — `run` is ours, not the protocol's.
export const toolManifest = () =>
  TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
