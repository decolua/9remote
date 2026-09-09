// test-opencode-web/server/sessions.mjs
// Discovers past OpenCode sessions via `opencode session list`

import { execSync } from "node:child_process";

export async function listOpenCodeSessions(limit = 25) {
  try {
    const stdout = execSync("opencode session list", { encoding: "utf8", timeout: 3000 });
    const lines = stdout
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("Session ID") && !l.startsWith("─"));

    const sessions = [];

    for (const line of lines) {
      const parts = line.split(/\s{2,}/);
      const sessionId = parts[0]?.trim();
      if (sessionId && sessionId.startsWith("ses_")) {
        sessions.push({
          sessionId,
          title: parts[1]?.trim() || "Phiên OpenCode #" + sessionId.slice(0, 8),
          updatedAt: parts[2]?.trim() || "",
        });
      }
    }

    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}
