// test-codex-web/server/mcp.mjs
// Discovers Codex MCP servers from `codex mcp list` & ~/.codex/config.toml

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function listCodexMcpServers() {
  const servers = [];

  // 1. Try running `codex mcp list`
  try {
    const stdout = execSync("codex mcp list", { encoding: "utf8", timeout: 3000 });
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.startsWith("Name") || line.startsWith("---")) continue;
      const parts = line.split(/\s{2,}/);
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const target = parts[1].trim();
        const isUrl = target.startsWith("http://") || target.startsWith("https://");
        const status = line.includes("disabled") ? "disabled" : "enabled";

        servers.push({
          name,
          type: isUrl ? "http" : "stdio",
          target,
          status,
          enabled: status === "enabled",
        });
      }
    }
  } catch {}

  // 2. Fallback: Parse config.toml
  if (servers.length === 0) {
    try {
      const configPath = path.join(os.homedir(), ".codex", "config.toml");
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf8");
        const mcpMatches = content.matchAll(/\[mcp_servers\.([^\]]+)\]/g);
        for (const m of mcpMatches) {
          const name = m[1].replace(/"/g, "").trim();
          servers.push({
            name,
            type: "config",
            target: "configured in config.toml",
            status: "enabled",
            enabled: true,
          });
        }
      }
    } catch {}
  }

  return servers;
}
