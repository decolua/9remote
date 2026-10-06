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

# 9remote browser operations — terminal vocabulary

\`9remote browser\` talks to the host's browser engine over its local API. The engine
spawns an isolated Chrome profile by default (safe); the user may attach their real
browser after enabling remote debugging.

## Command reference

\`\`\`bash
# ---- navigate ----
9remote browser go <url> [--new] [--wait "text"]   # navigate AND print the table (reuses a tab already on the url)
9remote browser go tab <#n|id|title|url>           # switch tab instead of navigating
9remote browser ls [--from N] [--tail [N]] [--parent SECTION]  # element table, windowed like less
9remote browser tabs [--attach]                    # list open tabs (* #1 [id] 🚀 [1] Title — URL)

# ---- read / search ----
9remote browser grep "<pattern>" [-C N] [-n] [-v] [-m N] [-q] [--links] [--parent S]
                                                     # grep(1) over page text; --links lists label -> url
9remote browser cat [--parent S] [--head N] [--tail N] [--from N --len N]
                                                     # full markdown-lite page read
9remote browser find "<needle>"                     # find(1) over the ELEMENT table (id/label/role/href)
9remote browser console                             # page console ring — JS errors (last 100)

# ---- act ----
9remote browser run "<sub-goal>" [--url URL] [--max-steps N] [--only RE] [--parent SECTION] [--fields "L=text;..."] [--expect-text "..." ...]
                                                     # Jev loop until DONE/BLOCKED; --expect-* verified on a
                                                     # fresh read — only PASSED is success
9remote browser click <id> [--prompt "text"]        # click table id; --prompt answers a window.prompt()
9remote browser type <id> "<exact text>" [--enter]  # type text YOU chose
9remote browser select <id> "<option>" | hover <id> | key <enter...> | enter
9remote browser scroll <top|bottom|down|up|to X|y N>
9remote browser wait "<text>"                       # bounded wait until text/element appears
9remote browser shot                                # jpeg screenshot (visual confirmation ONLY)

# ---- batch: ONE spawn, N commands ----
9remote browser sh < script.txt                     # each line = one command; a failing line does NOT stop
                                                     # the rest; trailing "&" suppresses that line's table
9remote browser chain "go /login; grep 'Sign in'; click btn1 'Continue'"
9remote browser chain --steps '<JSON>'              # canonical: typed, nestable, when-guards
\`\`\`

## Division of labor

- Jev handles navigation, clicks, toggles, scrolling — call \`run\` with a narrow
  sub-goal and let it click through; each decision is ~1s and free.
- YOU handle text, judgment and the final check: \`type\` with the exact string
  (keep diacritics verbatim), \`enter\` to send, then verify with \`grep\` or \`ls\`.

## Outcome handling

\`run\` returns an outcome. Never report success before your own check:

- \`needs_verification\` — Jev believes it is done. Check the returned element
  table (or \`shot\` for visuals) before claiming success.
- \`blocked\` / \`no_progress\` — the returned table shows why; usually a field Jev
  cannot fill. Do that step yourself (\`type\`/\`enter\`), then \`run\` again to resume.

## Rules

- ⚡⚡⚡ ONESHOT PATTERN: ONE chain CALL per task — chain and run NESTED BOTH WAYS. ⚡⚡⚡
  Every task (form, navigation, funnel, search) MUST be ONE \`chain\` call. \`run\` steps live
  inside the chain, and a \`run\` step may carry its own \`steps\` sub-chain (chain ⇄ run nesting).
  NEVER issue single browser commands. NEVER split a task into multiple single clicks/types.

- 🚀 SPECULATE FORWARD — a wrong guess costs NOTHING (fail-fast stops exactly there), a right
  guess saves a whole round trip. Fill the chain to the END of the task (up to 50 steps):
  predict the NEXT page's buttons before seeing them — click/type by \`label\` (labels survive
  renumbered ids), add \`tryLabels\` for label variants (\`"tryLabels":["Đăng nhập","Sign in","Log in"]\`),
  branch with \`when\` guards, verify inline with \`grep\`. The engine re-observes once on a
  not-observed miss and tries every variant before the chain breaks — so guess aggressively.
  When it does break, the response names the step and returns the live table: re-plan the
  REMAINING steps in one new chain. Two shots is the ceiling, one is the target.

  **CANONICAL FORM — \`--steps '<JSON>'\`:**
  \`\`\`bash
  9remote browser chain --steps '[
    {"op":"go","url":"http://shop.com"},
    {"op":"grep","pattern":"Logitech"},
    {"op":"run","goal":"lọc Phụ kiện và bấm Mua ngay Chuột MX","expectUrl":"/shop/cart",
     "steps":[{"op":"click","label":"Tiếp tục thanh toán"}]},
    {"op":"type","label":"Mã giảm giá","text":"SALE50"},
    {"op":"click","label":"Áp dụng","when":{"text":"SALE50"}},
    {"op":"grep","pattern":"Tổng tiền"}
  ]'
  \`\`\`
  Step types (12 ops — terminal verbs):
  - Navigate: \`{"op":"go","url":...}\` | \`{"op":"go","tab":2|"H1"}\` (\`"new":true\` forces a fresh tab) | \`{"op":"wait","text":...,"ms":N}\`
  - Act: \`{"op":"click"|"select","id":"btn7","label":"guard","prompt":"answer","tryLabels":["Variant B","Variant C"]}\` |
    \`{"op":"type","id":"inp1","text":"...","enter":true,"tryLabels":[...]}\` | \`{"op":"enter"}\` |
    \`{"op":"hover","id":"a1"}\` | \`{"op":"scroll","to":"btn7"|"text"|"y":4200,"direction":"down"}\` |
    \`{"op":"run","goal":...,"only":...,"parent":...,"fields":{...},"expectText":[...],"expectUrl":...,"steps":[sub-chain]}\`
  - Read: \`{"op":"cat","parent":...,"head":N,"tail":N}\` |
    \`{"op":"grep","pattern":...,"context":N,"lineNumbers":true,"invert":false,"max":N,"links":false,"quiet":true,"head":N,"tail":N,"parent":...}\` |
    \`{"op":"find","pattern":"nút gửi"}\`
  - **when-guard (if/else)**: any step may carry \`"when":{"text":"Còn hàng"}\` (or \`textNot\`/\`url\`) —
    unmet ⇒ the step is SKIPPED, not failed. Complementary guards = if/else. A non-quiet
    \`grep\` with zero hits FAILS the chain (assertion); \`"quiet":true\` turns it into a branch check.
  - \`run.steps\` sub-chain: max 3 nesting levels, 30 steps total (nested included). A sub-step
    failure fail-fasts the whole chain, attributed to the parent run step.
  - Reading steps (\`cat\`/\`grep\`/\`find\`) return their text INSIDE the chain results —
    verify mid-journey without losing the oneshot.

  **WHEN THE CHAIN BREAKS (fail-fast):** the response names the exact step, returns the LIVE
  element table at the break point and which steps were skipped/failed. Immediately issue ONE
  NEW chain for the REMAINING steps only — never fall back to single commands.

- Zero/minimal reasoning (Action-first): read the element table and immediately call the
  matching CLI command. No long speculative analysis while driving the browser.
- Round trips are the cost: every CLI call spends one of your turns. \`go\`, \`click\`,
  \`type\` (--enter) and \`run\` all RETURN the new element table — never follow with \`ls\`.
  Prefer \`grep\` over \`cat\` (filtered beats full). Batch shell steps with \`&&\`.
- \`ls\` windowing: dense pages cap at 248 elements — the header says
  \`[elements 1-248 of 731]\`; call \`ls --from 248\` (next window), \`ls --tail\` (last),
  \`ls --parent "Section"\` (one subtree).
- Element table lines carry link destinations: \`a5 link "Docs" -> https://...\` —
  use them with \`go\` instead of clicking blind.
- \`--only\` matches CLICK/SELECT labels only; text fields are never offered to Jev.
  If a command fails, change approach or report the error — never read the tool's source.
- Let Jev scroll inside \`run\` (it has SCROLL) instead of clicking scroll controls yourself.
- When a run ends \`no_progress\`/\`blocked\` or a click does nothing, check the console:
  failed responses carry the last lines; \`9remote browser console\` reads the full ring.
- Form journeys: \`run --fields "Email=a@b.c;Password=…"\` — engine types your exact text,
  passwords masked and never sent to the model.
- Declare an expect for EVERY movement goal (\`--expect-text "Order confirmed"\`); the engine
  verifies on a fresh read and AUTO-CONTINUES the loop until they pass.
- \`shot\` is ONLY final visual confirmation (layout, colors). NEVER use screenshots to
  locate or identify elements — the element table is the single source of truth.
- Never automatically rerun a failed task that may have mutated the site — reconcile
  the state first (\`ls\`/\`grep\`), then continue.
- Write sequential sub-goals as ONE goal in order; batch mixed needs as ONE chain of steps.
- NEVER write custom Node.js scripts or raw WebSocket code to reach DevTools. Always use
  \`9remote browser ...\` commands.
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
