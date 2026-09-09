// test-codex-web/server/sessions.mjs
// Discovers past Codex sessions from ~/.codex/session_index.jsonl

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

export async function listCodexSessions(limit = 25) {
  const homeDir = os.homedir();
  const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");

  if (!fs.existsSync(indexPath)) return [];

  const sessions = [];

  try {
    const fileStream = fs.createReadStream(indexPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id) {
          sessions.push({
            sessionId: item.id,
            title: item.thread_name || "Phiên Codex #" + item.id.slice(0, 8),
            updatedAt: item.updated_at ? new Date(item.updated_at).getTime() : Date.now(),
          });
        }
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, limit);
}
