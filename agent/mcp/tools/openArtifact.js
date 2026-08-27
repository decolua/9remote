// Show a file the AI just made in the app's side panel.
import { openArtifact } from "../../features/artifact/artifactService.js";

const openArtifactTool = {
  name: "openArtifact",
  description:
    "Show a file you just created or edited in the 9Remote app, sliding it in beside " +
    "the terminal. Use it for files worth looking at — html, markdown, svg, images, " +
    "pdf, csv, diagrams, code. Skip files with nothing to see. The user closes it themselves.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file." },
      title: { type: "string", description: "Optional label for the panel header." },
    },
    required: ["path"],
  },
  // Returns a string on success, or { error } — the server turns both into MCP content.
  run({ path, title }, ctx) {
    const result = openArtifact({ path, title }, ctx?.sessionId);
    return result.error ? result : `Opened ${result.path}`;
  },
};

export default openArtifactTool;
