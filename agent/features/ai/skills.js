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
  // Each engine reads where IT keeps skills — every path below was found on disk, not
  // inferred. The old shape was `codex ? codex-dir : claude-dir`, so opencode and
  // antigravity were shown claude's library as if it were theirs: 18 rows of another
  // CLI's skills, in a modal that offers them as things this engine can run.
  const dirs = skillDirs(engine, home, workspacePath);

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

/** Every place one engine reads skills from, most specific last. */
function skillDirs(engine, home, workspacePath) {
  if (engine === "codex") return [path.join(home, ".codex", "skills")];
  if (engine === "opencode") return [path.join(home, ".config", "opencode", "skills")];
  if (engine === "antigravity") {
    // Both are real: the user's own library and the CLI's shipped ones.
    return [
      path.join(home, ".gemini", "skills"),
      path.join(home, ".gemini", "antigravity-cli", "builtin", "skills")
    ];
  }
  if (engine === "claude") {
    return [
      path.join(home, ".claude", "skills"),
      path.join(home, ".claude", "skills copy"),
      ...(workspacePath ? [path.join(workspacePath, ".claude", "skills")] : [])
    ];
  }
  // An engine nobody has taught: no library, rather than another engine's.
  return [];
}
