// test-opencode-web/server/mcp.mjs
// Discovers OpenCode MCP servers via `opencode mcp list`

import { execSync } from "node:child_process";

export function listOpenCodeMcpServers() {
  try {
    const raw = execSync("opencode mcp list", { encoding: "utf8", timeout: 3000 });
    // Remove ANSI color codes
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = clean.split("\n");

    const servers = [];
    let currentServer = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("●")) {
        const parts = trimmed.split(/\s+/);
        // e.g. "● ✗ 1devtool failed" or "● ✓ 9remote connected"
        const nameIdx = parts.findIndex((p) => p !== "●" && p !== "✓" && p !== "✗");
        if (nameIdx !== -1) {
          const name = parts[nameIdx];
          const status = parts.slice(nameIdx + 1).join(" ") || "connected";
          currentServer = {
            name,
            status,
            enabled: !status.includes("failed") && !status.includes("disabled"),
            target: "",
          };
          servers.push(currentServer);
        }
      } else if (currentServer && trimmed.startsWith("│") && !currentServer.target) {
        const target = trimmed.replace(/^│\s*/, "");
        if (target && !target.includes("ENOENT")) {
          currentServer.target = target;
        }
      }
    }

    return servers;
  } catch {
    return [];
  }
}
