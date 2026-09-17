// Which card a plan and a code review draw as.
//
// Two things were wrong here, and both said something false on screen:
//   • codex's `update_plan` fell to the GENERIC card — raw JSON where the plan belongs,
//     because the plan card only ever looked for claude's `reason`;
//   • codex's review pair was drawn by CLAUDE's plan-mode card, which reads "Plan Mode
//     Activated" and names that engine — for a code review, in another CLI.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiPlanAndReviewCards.test.mjs
import assert from "node:assert/strict";
import { getToolCategory } from "../features/ai/registry.js";

let pass = 0, fail = 0;
const test = (n, f) => {
  try { f(); pass++; console.log(`  ok  ${n}`); }
  catch (e) { fail++; console.error(`  FAIL ${n}\n       ${e.message}`); }
};

test("a codex plan draws as a plan, not as the generic row", () => {
  assert.equal(getToolCategory("codex", "update_plan"), "plan");
});

test("claude's plan-mode pair is unchanged", () => {
  assert.equal(getToolCategory("claude", "EnterPlanMode"), "plan");
  assert.equal(getToolCategory("claude", "ExitPlanMode"), "plan");
});

test("a codex review draws as a review, not as plan mode", () => {
  assert.equal(getToolCategory("codex", "enteredReviewMode"), "review");
  // An image the model GENERATED (the server's `imageGeneration` item). A file row, and
  // the row's whole content is the path it was saved to; unmapped it printed raw JSON.
  assert.equal(getToolCategory("codex", "image_generation"), "file");
  assert.equal(getToolCategory("codex", "exitedReviewMode"), "review");
});

// Every category this file names must have an entry in toolCards' `CARDS` map, or the row
// renders NOTHING — worse than the generic card it replaced. The map cannot be imported
// here (JSX, no bundler), so it is read as text: a name that appears in the registry and
// nowhere in the card map is the failure this catches.
test("every category these names produce has a card behind it", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../features/ai/components/cards/toolCards.jsx", import.meta.url), "utf8");
  const categories = new Set(
    ["update_plan", "enteredReviewMode", "exitedReviewMode", "EnterPlanMode"]
      .map((n) => getToolCategory("codex", n))
  );
  for (const c of categories) {
    assert.match(src, new RegExp(`^\\s*${c}:`, "m"), `no card is registered for "${c}"`);
  }
});

// Found by auditing one machine's transcripts: every tool name a CLI really emitted, and
// the card it drew. `Monitor` ran a shell command and waited on its output — 44 uses, all
// falling to the generic row, so a monitored command read as an unknown tool.
test("a tool that runs a shell command draws as a shell, whatever its name", () => {
  assert.equal(getToolCategory("claude", "Monitor"), "bash");
});

// An engine that CAN rewind must have a way in. Codex gained `thread/revert` and kept
// only the modal — no menu entry — so the feature existed and could not be reached, while
// claude and opencode both listed it.
test("every engine that can rewind offers the command that opens it", async () => {
  const { getEngineConfig } = await import("../features/ai/registry.js");
  for (const engine of ["claude", "codex", "opencode"]) {
    const cfg = getEngineConfig(engine);
    assert.ok(cfg.features.rewind, `${engine} is expected to support rewind`);
    assert.ok(cfg.slashCommands.some((c) => c.name === "/rewind"), `${engine} has no /rewind to reach it`);
  }
});

// The goal the pane already DRAWS (AiStatusBar, read from codex's state DB) had no way to
// be set from the composer: the TUI's `/goal` was missing from the menu. Verified against
// the real CLI — `thread/goal/get` comes back null, and non-null after the command is sent.
test("an engine whose goal the pane shows offers the command that sets it", async () => {
  const { getEngineConfig } = await import("../features/ai/registry.js");
  const names = getEngineConfig("codex").slashCommands.map((c) => c.name);
  assert.ok(names.includes("/goal"), "codex has /goal to set or view the goal");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
