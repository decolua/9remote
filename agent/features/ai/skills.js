import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let cachedSkills = { claude: null, codex: null, at: 0 };
const CACHE_TTL_MS = 10000;

function parseSkillMd(mdPath, fallbackName) {
  try {
    const content = fs.readFileSync(mdPath, "utf8");
    const match = content.match(/^---\s*([\s\S]*?)\s*---/);
    let name = fallbackName;
    let description = `Skill: ${fallbackName}`;
    if (match) {
      const yaml = match[1];
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      const descMatch = yaml.match(/^description:\s*([\s\S]*?)(?=\n[a-z_]+:|$)/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim().replace(/\n+/g, " ");
    }
    return { name, description };
  } catch {
    return { name: fallbackName, description: `Skill: ${fallbackName}` };
  }
}

function scanSkillDir(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillPath = path.join(baseDir, entry.name);
      const mdPath = path.join(skillPath, "SKILL.md");
      const { name, description } = parseSkillMd(mdPath, entry.name);
      results.push({
        id: entry.name,
        name,
        description,
        path: skillPath
      });
    }
  } catch {}
  return results;
}

export function listSkills(engine = "claude", workspacePath = null) {
  const now = Date.now();
  if (cachedSkills[engine] && now - cachedSkills.at < CACHE_TTL_MS) {
    return cachedSkills[engine];
  }

  const home = os.homedir();
  const dirs = [];

  if (engine === "codex") {
    dirs.push(path.join(home, ".codex", "skills"));
  } else {
    dirs.push(path.join(home, ".claude", "skills"));
    dirs.push(path.join(home, ".claude", "skills copy"));
    if (workspacePath) {
      dirs.push(path.join(workspacePath, ".claude", "skills"));
    }
  }

  const map = new Map();
  for (const dir of dirs) {
    for (const s of scanSkillDir(dir)) {
      if (!map.has(s.id)) map.set(s.id, s);
    }
  }

  const list = Array.from(map.values());
  cachedSkills[engine] = list;
  cachedSkills.at = now;
  return list;
}
