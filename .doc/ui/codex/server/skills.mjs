// test-codex-web/server/skills.mjs
// Discovers Codex skills from ~/.codex/skills

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let cachedSkills = [];
let lastScanTime = 0;
const CACHE_TTL_MS = 10000;

export function listCodexSkills() {
  const now = Date.now();
  if (cachedSkills.length > 0 && now - lastScanTime < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const skillsDir = path.join(os.homedir(), ".codex", "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const results = [];

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const skillPath = path.join(skillsDir, entry.name);
      const mdPath = path.join(skillPath, "SKILL.md");

      let name = entry.name;
      let description = `Codex skill: ${entry.name}`;

      if (fs.existsSync(mdPath)) {
        try {
          const content = fs.readFileSync(mdPath, "utf8");
          // Extract YAML frontmatter
          const match = content.match(/^---\s*([\s\S]*?)\s*---/);
          if (match) {
            const yaml = match[1];
            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            const descMatch = yaml.match(/^description:\s*([\s\S]*?)(?=\n[a-z_]+:|$)/m);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim().replace(/\n+/g, " ");
          }
        } catch {}
      }

      results.push({
        id: entry.name,
        name,
        description,
        path: skillPath,
      });
    }
  } catch {}

  cachedSkills = results;
  lastScanTime = now;
  return results;
}
