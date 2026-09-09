import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function listMcpServers(engine = "claude") {
  const home = os.homedir();
  const servers = [];

  // 1. Claude Code MCP from ~/.claude/settings.json
  try {
    const claudeSettingsPath = path.join(home, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const data = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
      const mcpMap = data.mcpServers || {};
      for (const [name, cfg] of Object.entries(mcpMap)) {
        servers.push({
          id: name,
          name,
          type: "stdio",
          command: cfg.command || "",
          status: "configured",
          engine: "claude"
        });
      }
    }
  } catch {}

  // 2. Codex MCP from ~/.codex/config.toml
  if (engine === "codex" || servers.length === 0) {
    try {
      const codexConfigPath = path.join(home, ".codex", "config.toml");
      if (fs.existsSync(codexConfigPath)) {
        const text = fs.readFileSync(codexConfigPath, "utf8");
        const matches = text.matchAll(/\[mcp_servers\.([^\]]+)\]/g);
        for (const m of matches) {
          const name = m[1];
          if (!servers.some((s) => s.name === name)) {
            servers.push({
              id: name,
              name,
              type: "stdio",
              status: "configured",
              engine: "codex"
            });
          }
        }
      }
    } catch {}
  }

  return servers;
}
