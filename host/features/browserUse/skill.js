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
9remote browser read [--tail] [--profile NAME]           # filtered page TEXT — read content with this, never with shot
9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only RE] [--expect-text "..." ...]
                                                            # Jev loop until DONE/BLOCKED; --only narrows
                                                            # the table; --expect-* declares end conditions
                                                            # the engine verifies on a fresh read
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
- \`--only\` matches CLICK/SELECT element labels only — text fields are never
  offered to Jev (typing is yours). If a command fails, change approach or
  report the error — never read the tool's source code to debug it.
- Let Jev scroll inside \`run\` (it has SCROLL) instead of clicking scroll
  controls yourself step by step.
- Declare an expect for EVERY movement goal, even plain scrolling
  (\`run "scroll to the footer" --expect-text "Guidelines"\`) — auto-continue then
  drives it to the end in one command instead of many single-scroll runs.
- When a task needs 2+ consecutive clicks following links, describe the
  destination in ONE \`run\` — do not click ids one by one.
- \`--only\` fragments must be long enough to be specific — a bare "2" matches
  every label containing the digit 2.
- \`state\` is only for re-reading mid-task. \`shot\` is ONLY final visual confirmation
  (layout, colors, images — things text cannot tell). NEVER use screenshots to locate,
  count or identify elements: the element table is the single source of truth for ids,
  and a screenshot shows none of them.
- Declare measurable end conditions up front: \`run --expect-text "Order confirmed" --expect-url ...\`.
  The engine verifies them on a fresh read and AUTO-CONTINUES the Jev loop until they
  pass (bounded chunks) — one command can carry the whole journey to a verified end.
  Goal should name the DESTINATION (the outcome), not a single action — Jev handles
  the steps itself. Only a PASSED verification is success; a DONE claim alone is
  never proof. \`--expect-text\` matches visible page text AND filled field values.
- Never automatically rerun a failed task that may have mutated the site — reconcile the
  actual state first, then continue.
- One working profile per task; pass \`--profile\` consistently. A profile is
  created automatically on first use — no separate \`profiles create\` needed.
- Write sequential sub-goals as ONE goal in order ("open X, then click Y, then
  open Z") — the run loop executes the chain itself; do not split into many runs.
- Never type into or click elements of pages the user did not ask you to touch.
`;

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
