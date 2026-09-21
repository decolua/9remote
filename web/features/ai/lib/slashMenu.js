// '/' menu assembly: host commands first, then live engine commands (opencode's
// GET /command feed, omp's available_commands_update), then skills — one entry
// per name with first-wins dedupe, lowercase substring filter on the name.

export function buildSlashItems({ staticCommands = [], liveCommands = [], skills = [], filter = "" } = {}) {
  const live = (liveCommands || []).map((c) => ({
    name: `/${c.name}`,
    description: c.description || "",
    isCommand: true
  }));
  const skillCmds = (skills || []).map((s) => ({
    name: `/${s.name || s.id}`,
    description: s.description || `Skill: ${s.name || s.id}`,
    isSkill: true
  }));
  const seen = new Set();
  const needle = String(filter || "").toLowerCase();
  return [...(staticCommands || []), ...live, ...skillCmds].filter((cmd) => {
    if (seen.has(cmd.name) || !cmd.name.toLowerCase().includes(needle)) return false;
    seen.add(cmd.name);
    return true;
  });
}
