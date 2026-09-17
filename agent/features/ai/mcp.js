import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * The MCP servers one engine actually has.
 *
 * Each engine reads its OWN config, and only its own. The codex branch used to run for
 * every engine, so the modal listed claude's servers as codex's and vice versa — and
 * opencode/antigravity, which have no reader of their own, showed claude's list as if it
 * were theirs. An engine with no reader returns nothing rather than borrowing another's.
 */
export function listMcpServers(engine = "claude") {
  if (engine === "claude") return claudeServers();
  if (engine === "codex") return codexServers();
  return [];
}

/** Claude keeps them in ~/.claude/settings.json, keyed by name. */
function claudeServers() {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.entries(data.mcpServers || {}).map(([name, cfg]) => ({
      id: name,
      name,
      type: cfg.url ? "http" : "stdio",
      command: cfg.command || cfg.url || "",
      status: "configured"
    }));
  } catch {
    return [];
  }
}

/**
 * Codex keeps them in ~/.codex/config.toml as `[mcp_servers.<name>]` tables.
 *
 * Only the tables that ARE a server. The same file nests options under them
 * (`[mcp_servers."9remote".http_headers]`, `[mcp_servers.node_repl.env]`), and matching
 * the heading alone listed those as servers of their own — four phantom rows on this
 * machine, named after the option rather than the server.
 */
function codexServers() {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  // The name may be quoted (a dotted or spaced name), and an option table adds a suffix.
  for (const m of text.matchAll(/^\s*\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)((?:\.[^\]]+)*)\]\s*$/gm)) {
    if (m[2]) continue; // a sub-table is an option of the server above, not a server
    const name = m[1].replace(/^"|"$/g, "");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, name, type: "stdio", status: "configured" });
  }
  return out;
}
