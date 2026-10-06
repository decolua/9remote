// Ships the 9remote-browser skill into an agent CLI's skill directory so
// terminal agents discover the browser commands on their own (same
// distribution idea as herdr / jev-browser-use, but the host installs it —
// no npx needed). On demand only: one engine at a time, while the feature is
// enabled; disabling removes it again. Idempotent on content.
import fs from "node:fs";
import os from "node:os";
import { skillDirs } from "../ai/skills.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("browserUse");

export const SKILL_NAME = "9remote-browser";

const SKILL_MD = "---\nname: 9remote-browser\ndescription: Drive the machine's Chrome through the 9remote host — Jev (fast, free) does clicks and navigation, you do text and verification. Use when the user asks to open, read, fill, click or check something in a browser on this machine. Do not use merely because a task could involve a web page; plain fetch/curl is enough for public data.\n---\n\n# 9remote browser — Chain-First Browser Driver\n\n`9remote browser` drives Chrome through the host's local API.\n\n⚡⚡⚡ MANDATORY RULE: ONE-SHOT CHAIN ⚡⚡⚡\nEvery browser task (navigating, searching, filling forms, reading) MUST be executed using ONE `chain` call.\nDO NOT issue single `go`, `click`, `type`, `read`, or `search` commands one by one! Sequential single\ncalls incur huge round-trip latency and are strictly forbidden. Draft the ENTIRE journey from start\nto finish in a single `chain --steps '[...]'` call.\n\n## Primary Interface: chain (Canonical)\n\n```bash\n9remote browser chain --steps '[\n  {\"op\":\"go\",\"url\":\"https://github.com/trending?since=weekly\"},\n  {\"op\":\"search\",\"pattern\":\"stars this week\",\"context\":2},\n  {\"op\":\"read\",\"parent\":\"Trending\"}\n]'\n```\n\n### Chain Step Operations (12 verbs):\n- **Navigate**:\n  - `{\"op\":\"go\",\"url\":\"...\"}` (navigates or switches to existing tab)\n  - `{\"op\":\"go\",\"tab\":1}` (switch to tab index #1)\n  - `{\"op\":\"wait\",\"text\":\"...\"}` | `{\"op\":\"wait\",\"ms\":1000}`\n- **Read & Search**:\n  - `{\"op\":\"search\",\"pattern\":\"...\",\"context\":2,\"links\":false}` (searches page text, extracts links with \"links\":true)\n  - `{\"op\":\"read\",\"parent\":\"Section\"}` (reads markdown-lite page/section text, capped to budget)\n  - `{\"op\":\"find\",\"pattern\":\"...\"}` (filters element table by keyword/role/href)\n- **Act**:\n  - `{\"op\":\"click\",\"label\":\"Login\",\"tryLabels\":[\"Sign In\",\"Log In\"]}` (clicks by label; tryLabels tries variants before stopping)\n  - `{\"op\":\"type\",\"label\":\"Search\",\"text\":\"query\",\"enter\":true}` (types into input, optionally presses enter)\n  - `{\"op\":\"select\",\"label\":\"Role\",\"option\":\"Admin\"}`\n  - `{\"op\":\"scroll\",\"to\":\"Footer\"|\"direction\":\"down\"}`\n  - `{\"op\":\"enter\"}`\n- **Delegate**: `{\"op\":\"run\",\"goal\":\"...\",\"expectText\":[\"...\"]}` (Jev fast automation loop)\n- **Branching**: any step can have `\"when\":{\"text\":\"...\"}` or `\"when\":{\"textNot\":\"...\"}` — skips the step if unmet (if/else).\n\n**WHEN THE CHAIN BREAKS (fail-fast):** The response names the failing step and returns the LIVE\nelement table at the break point. Immediately issue ONE NEW chain for the REMAINING steps — never fall back to single commands.\n\n## Inspection Commands (Only for Diagnosing Stopped Chains)\n\nUse ONLY when diagnosing a broken chain or inspecting browser tabs:\n```bash\n9remote browser ls [--from N] [--tail [N]] [--parent S]   # view live element table\n9remote browser tabs [--attach]                            # list open browser tabs\n9remote browser console                                   # view last JS console errors\n9remote browser shot                                      # screenshot /tmp/9remote-shot-*.jpg\n```\n\n## Standalone Verbs (Quick debugging only — use Chain for real tasks)\n\n```bash\n9remote browser go <url> [--new] [--wait \"text\"]\n9remote browser search \"<pattern>\" [-C N] [-B N] [-A N] [-n] [-v] [-m N] [-q] [--links]\n9remote browser read [--parent S] [--head N] [--tail N] [--from N --len N]\n9remote browser find \"<needle>\"\n9remote browser click <id> [--prompt \"text\"]\n9remote browser type <id> \"<text>\" [--enter]\n9remote browser run \"<goal>\" [--url URL] [--max-steps N] [--fields \"L=v;...\"]\n9remote browser sh < script.txt\n9remote browser close | attach | status\n```\n";

export const SKILL_ENGINES = ["claude", "codex", "opencode", "antigravity", "hermes"];

// Install into ONE engine's first existing skills dir. Idempotent on content.
// Best-effort per dir: one unwritable dir must not fail the whole install.
export async function installSkillForEngine(engine) {
  const home = os.homedir();
  const installed = [];
  for (const dir of skillDirs(engine, home, null)) {
    // Only install where the engine already keeps a skills library.
    if (!fs.existsSync(dir)) continue;
    try {
      const target = `${dir}/${SKILL_NAME}`;
      fs.mkdirSync(target, { recursive: true });
      const file = `${target}/SKILL.md`;
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (current !== SKILL_MD) fs.writeFileSync(file, SKILL_MD);
      installed.push(`${engine}:${target}`);
      break;
    } catch (e) {
      logger.warn(`skill install into ${dir} failed: ${e.message}`);
    }
  }
  return { installed };
}

// Disable path: sweep every engine's dirs so no agent can call a dead engine.
// Only our own SKILL_NAME dir is ever removed, never anything shipped.
// Best-effort per dir: one locked dir must not fail the toggle or skip the rest.
export function removeAllInstalledSkills() {
  const home = os.homedir();
  const removed = [];
  const failed = [];
  for (const engine of SKILL_ENGINES) {
    for (const dir of skillDirs(engine, home, null)) {
      const target = `${dir}/${SKILL_NAME}`;
      if (!fs.existsSync(target)) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(`${engine}:${target}`);
      } catch (e) {
        failed.push(`${engine}:${target}`);
        logger.warn(`skill remove from ${dir} failed: ${e.message}`);
      }
    }
  }
  if (removed.length) logger.info(`skill removed: ${removed.join(", ")}`);
  return { removed, failed };
}

// Fire-and-forget just-in-time install for one engine; the enabled gate lives
// in browserUseSocket (dynamic import — that file statically imports this one).
export function queueSkillInstall(engine) {
  if (!engine || !SKILL_ENGINES.includes(engine)) return;
  void import("./browserUseSocket.js")
    .then((m) => m.installSkillIfEnabled(engine))
    .catch((e) => logger.debug(`skill install skipped: ${e.message}`));
}
