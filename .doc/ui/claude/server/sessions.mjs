// test-claude-web/server/sessions.mjs
// Discovers past sessions for /resume functionality

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

function getProjectSessionDir(projectPath) {
  const homeDir = os.homedir();
  // Claude encodes project path as -Users-Working-9remote
  const sanitized = projectPath.replace(/\/+$/, "").replace(/\//g, "-");
  return path.join(homeDir, ".claude", "projects", sanitized);
}

export async function listProjectSessions(projectPath, limit = 20) {
  const sessionDir = getProjectSessionDir(projectPath);
  if (!fs.existsSync(sessionDir)) return [];

  const files = fs.readdirSync(sessionDir);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const sessions = [];

  for (const file of jsonlFiles) {
    const fullPath = path.join(sessionDir, file);
    const stat = fs.statSync(fullPath);
    const sessionId = file.replace(".jsonl", "");

    // Extract first user prompt as title
    let title = "Phiên làm việc " + sessionId.slice(0, 8);
    try {
      const fileStream = fs.createReadStream(fullPath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "user" && parsed.message?.content) {
            const content = typeof parsed.message.content === "string"
              ? parsed.message.content
              : Array.isArray(parsed.message.content)
                ? parsed.message.content.find((c) => c.text)?.text || ""
                : "";
            if (content && !content.startsWith("/")) {
              title = content.slice(0, 80);
              break;
            }
          }
        } catch {}
      }
      fileStream.destroy();
    } catch {}

    sessions.push({
      sessionId,
      title,
      updatedAt: stat.mtimeMs,
      size: stat.size,
    });
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, limit);
}
