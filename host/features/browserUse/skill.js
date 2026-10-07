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

const SKILL_MD = "---\nname: 9remote-browser\ndescription: Drive the machine's Chrome through the 9remote host \u2014 one chain per task, run handles unknown pages, you do text and verification. Use when the user asks to open, read, fill, click or check something in a browser on this machine. Do not use merely because a task could involve a web page; plain fetch/curl is enough for public data.\n---\n\n# 9remote browser \u2014 One-Shot Journeys\n\nONE browser task = ONE `chain` call that runs ALL the way to the goal. Exactly 3 commands exist; everything else is disabled.\n\n## Why ONE long chain (read this once)\n\nEvery CLI call costs a full model turn \u2014 re-reading context, deciding, writing the\ncommand. Ten steps as ten calls = ten model turns; as ONE chain = ONE model turn,\nand the engine then runs the steps at machine speed, seeing the LIVE page between\nsteps (adaptive settle, label retry, self-heal) \u2014 faster and more accurate than\nyou guessing from a table that is one step stale.\n\nGUESSING IS SAFE HERE \u2014 that is the whole design: every step is verified before\nit runs (exact label match, ambiguity throws, navigation guards, when-checks),\nso a wrong guess stops the chain AT that exact step and costs nothing beyond it;\nthe response hands back the live state + `pending` and ONE repair chain finishes.\nVerifying first by splitting the journey ALWAYS costs a full model turn; guessing\nwrong costs at most one step. Never work step-by-step \u2014 predict the whole path,\nlet the guards catch what you missed.\n\n## 1. chain \u2014 the interface\n\n```bash\n9remote browser chain --goal \"weekly trending report\" --steps '[\n  {\"op\":\"go\",\"url\":\"https://github.com/trending?since=weekly\"},\n  {\"op\":\"run\",\"goal\":\"dismiss any cookie banner\",\"expectText\":[\"Trending\"]},\n  {\"op\":\"click\",\"label\":\"Sign in\",\"when\":{\"textNot\":\"Signed in\"}},\n  {\"op\":\"type\",\"label\":\"Search\",\"text\":\"stars this week\",\"enter\":true},\n  {\"op\":\"search\",\"pattern\":\"stars this week\",\"context\":2},\n  {\"op\":\"find\",\"pattern\":\"Load more\"},\n  {\"op\":\"shot\"}\n]'\n```\n\n### 14 ops\n- **Move**: `{\"op\":\"go\",\"url\":\"\u2026\"}` \u00b7 `{\"op\":\"go\",\"tab\":1}` \u00b7 `{\"op\":\"wait\",\"text\":\"\u2026\",\"ms\":N}` \u00b7 `{\"op\":\"scroll\",\"to\":\"Footer\"|\"y\":800|\"direction\":\"down\"}`\n- **Act**: `{\"op\":\"click\",\"label\":\"Login\",\"tryLabels\":[\"Sign In\",\"Log In\"]}` \u2014 add `\"nav\":true` when this click navigates to the next page (a link you EXPECTED to follow; the chain then continues on the landing page) \u00b7 `{\"op\":\"type\",\"label\":\"Search\",\"text\":\"q\",\"enter\":true}` (enter submits \u2014 the chain follows the form) \u00b7 `{\"op\":\"select\",\"label\":\"Admin\"}` (target = the option) \u00b7 `{\"op\":\"hover\",\"label\":\"Menu\"}` \u00b7 `{\"op\":\"enter\"}` \u00b7 `{\"op\":\"upload\",\"label\":\"CV\",\"file\":\"/path/cv.pdf\"}`\n- **Read**: `{\"op\":\"read\",\"parent\":\"Section\"}` whole page (sections via `--parent`) \u00b7 `{\"op\":\"search\",\"pattern\":\"\u2026\",\"context\":2}` (`\"links\":true` = hrefs; `\"for\":8000` ONLY when evidence is known to arrive late) \u00b7 `{\"op\":\"find\",\"pattern\":\"login\"}` (no pattern = windowed table) \u00b7 `{\"op\":\"shot\"}` (jpg path in results)\n- **Delegate**: `{\"op\":\"run\",\"goal\":\"log in\",\"fields\":{\"Email\":\"me@x.co\",\"Password\":\"\u2026\"},\"expectText\":[\"Dashboard\"],\"steps\":[\u2026]}`\n  Hands the segment to Jev, a fast model deciding on the LIVE element table \u2014 use it for every segment whose labels you cannot predict (logins, cookie walls, dynamic UIs). `expectText` comes back **independently verified \u2014 safe to report success**. `steps` runs a sub-chain right after the verified pass.\n- **Every op** takes `\"when\":{\"text\"|\"textNot\"|\"url\"}` \u2014 skip-if-unmet; complementary guards compose if/else.\n\n### Hard rules\n1. **`--goal` on every chain.** It rides the break response (`goal \"\u2026\" \u2014 reached 3/7`) so the repair shot aims at the destination, not at the nearest fragment.\n2. **Plan to the END of the task, not to the next page.** A chain that stops one navigation short of the goal is a wasted shot.\n3. **Never verify-then-continue.** Do not split the journey to check an intermediate page \u2014 GUESS the next steps (or `run` them). The engine checks every step before running it and stops at the first wrong guess for free; a verification call costs a full model turn every time.\n4. **Unknown labels are NOT a reason to stop.** Put a `run` step there and keep planning the far side of it.\n5. **Never declare waits.** The engine settles between steps; only `search` takes `for` when a result is KNOWN slow.\n6. **When the chain breaks**: send ONE new chain = `pending` with the fix applied. The next call on the same session is checked against the owed steps.\n7. **No 1-step action chains, no read-only chains** \u2014 reads live inside the action chain. Both get called out in the response.\n\n## 2. batch \u2014 same ops, one per line (no JSON quoting)\n\n```bash\n9remote browser batch <<'EOF'\ngo https://github.com/trending\nsearch \"stars this week\" -C 2\nEOF\n```\n\n## 3. run \u2014 standalone hand-off of an unknown-label segment\n\n```bash\n9remote browser run \"log in and reach the reports page\" --fields \"Email=me@x.co;Password=s3cret\" --expect-text \"Reports\"\n```\n";



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
