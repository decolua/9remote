// Ships the 9remote-browser skill into every agent CLI's skill directory the
// host finds on this machine, so terminal agents discover the browser commands
// on their own (same distribution idea as herdr / jev-browser-use, but the
// host installs it — no npx needed). Idempotent: only rewrites on content change.
import fs from "node:fs";
import os from "node:os";
import { skillDirs } from "../ai/skills.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("browserUse");

export const SKILL_NAME = "9remote-browser";

const SKILL_MD = `---
name: 9remote-browser
description: Drive the machine's Chrome through the 9remote host — Jev (fast, free) does clicks and navigation, you do text and verification. Use when the user asks to open, read, fill, click or check something in a browser on this machine. Do not use merely because a task could involve a web page; plain fetch/curl is enough for public data.
---

# 9remote browser operations

\`9remote browser\` talks to the host's browser engine over its local API. The engine
spawns an isolated Chrome profile by default (safe); the user may attach their real
browser after enabling remote debugging.

## Command reference

\`\`\`bash
9remote browser open <url> [--profile NAME] [--attach]   # opens AND prints the element table
9remote browser state [--profile NAME]                   # numbered element table of current page
9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only RE]
                                                            # Jev loop until DONE/BLOCKED;
                                                            # --only narrows the table by label regex
9remote browser click <id>                               # click element by table id (e.g. e3)
9remote browser type <id> "<exact text>" [--enter]       # type text YOU chose; --enter sends it
9remote browser chain "click e1; type e2 'hi' --enter; select e3; wait 'Saved'"
                                                          # known multi-step sequence in ONE call
9remote browser enter                                    # press Enter (send/submit)
9remote browser shot [--profile NAME]                    # writes a jpeg, prints its path — view via your file tool
9remote browser close [--profile NAME]
9remote browser profiles                                 # list/create/delete browser profiles
\`\`\`

## Division of labor

- Jev handles navigation, clicks, toggles, scrolling — call \`run\` with a narrow
  sub-goal and let it click through; each decision is ~1s and free.
- YOU handle text, judgment and the final check: \`type\` with the exact string
  (keep diacritics verbatim), \`enter\` to send, then verify with the returned
  element table or \`shot\` for visuals.

## Outcome handling

\`run\` returns an outcome. Never report success before your own check:

- \`needs_verification\` — Jev believes it is done. Check the returned element
  table (or \`shot\` for visuals) before claiming success.
- \`blocked\` / \`no_progress\` — the returned table shows why; usually a field Jev
  cannot fill. Do that step yourself (\`type\`/\`enter\`), then \`run\` again to resume.

## Rules

- Round trips are the cost: every CLI call spends one of your turns. \`open\`,
  \`click\`, \`type\` (use \`--enter\`) and \`run\` all RETURN the new element table
  in the same response — never follow them with \`state\`. Chain fixed-order shell
  steps with \`&&\` in one call. On element-dense pages pass \`run --only <regex>\`
  so Jev chooses among matching labels only — faster and less error-prone.
  When the whole sequence is known upfront (form filling, open→type→submit),
  use \`chain\` instead of several commands: one call, one result table, and it
  stops at the first failing step with the live page state.
- \`state\` is only for re-reading mid-task; \`shot\` is for visual verification.
- One working profile per task; pass \`--profile\` consistently.
- Never type into or click elements of pages the user did not ask you to touch.
`;

export async function ensureSkillInstalled() {
  const home = os.homedir();
  const engines = ["claude", "codex", "opencode", "antigravity", "hermes"];
  const installed = [];
  for (const engine of engines) {
    for (const dir of skillDirs(engine, home, null)) {
      // Only install where the engine already keeps a skills library.
      if (!fs.existsSync(dir)) continue;
      const target = `${dir}/${SKILL_NAME}`;
      fs.mkdirSync(target, { recursive: true });
      const file = `${target}/SKILL.md`;
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (current !== SKILL_MD) fs.writeFileSync(file, SKILL_MD);
      installed.push(`${engine}:${target}`);
      break;
    }
  }
  if (installed.length) logger.debug(`skill installed: ${installed.join(", ")}`);
  return { installed };
}
