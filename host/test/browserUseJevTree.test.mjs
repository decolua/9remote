// Live probe: does Jev actually USE state.page.tree to disambiguate same-label
// targets the criteria table cannot tell apart? A/B — same question with and
// without the tree. Makes real decide() calls (free lane, no key).
// Run: node host/test/browserUseJevTree.test.mjs   (JEV_PRESET to override)
import { buildActionSpace, buildQuestions, scopeByParent } from "../features/browserUse/agentLoop.js";
import { decide, validateChoice } from "../features/browserUse/jevClient.js";

// Minimal ambiguous page: two cards (Billing / Shipping), each has a tab "Logs"
// with a Save button. ctx (closest section) is IDENTICAL for both and the goal
// names a card the criteria table never shows — only the tree carries the join
// key. A goal like "card 2" would leak the ordinal, so sections get real names.
const pair = [
  { id: "e1", node: 1, role: "button", label: "Save", kind: "click", ctx: "Logs", value: "", path: ["Billing", "Logs"] },
  { id: "e2", node: 2, role: "button", label: "Save", kind: "click", ctx: "Logs", value: "", path: ["Shipping", "Logs"] }
];
// Busy page: bury the pair in the middle of 120 same-shape rows so the tree is
// long and cycle-collapsed — the real-page condition the tiny probe skips.
const filler = Array.from({ length: 120 }, (_, i) => ({
  id: `e${i + 3}`, node: i + 3, role: "link", label: `Invoice ${String(i + 1).padStart(3, "0")}`,
  kind: "click", ctx: "Results", value: "", path: ["Results"]
}));

async function pick(withTree, goal, parent = null) {
  const actions = scopeByParent(pair.concat(filler), parent);
  const page = { url: "https://example.com/settings", title: "settings", text: "", headings: [], actions };
  const space = buildActionSpace(actions);
  const body = buildQuestions(page, goal, [], space);
  if (!withTree) body.state.page.tree = "";
  const result = await decide(body, { preset: process.env.JEV_PRESET || "free" });
  const answer = validateChoice(result.answers.click_target || {},
    Object.keys(body.questions.click_target.criteria));
  return answer ? { choice: answer.choice, conf: answer.confidence } : { choice: null, conf: null };
}

const RUNS = 6;
let okTree = 0, okBare = 0, okParent = 0;
for (let i = 0; i < RUNS; i++) {
  const card = i % 2 ? "shipping" : "billing"; // alternate to kill position bias
  const section = card === "billing" ? "Billing" : "Shipping";
  const expect = card === "billing" ? "e1" : "e2";
  const goal = `Press Save`;
  const withTree = await pick(true, `Press Save in the ${card} section`);
  const bare = await pick(false, `Press Save in the ${card} section`);
  // The --parent contract: LLM names the section, criteria is scoped, tree gone
  const scoped = await pick(false, goal, section);
  okTree += withTree.choice === expect;
  okBare += bare.choice === expect;
  okParent += scoped.choice === expect;
  console.log(`run ${i + 1}  ${card} (want ${expect})  ` +
    `tree=${withTree.choice}/${withTree.conf ?? "?"}  no-tree=${bare.choice}/${bare.conf ?? "?"}  ` +
    `parent=${scoped.choice}/${scoped.conf ?? "?"}`);
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`\ntree: ${okTree}/${RUNS} · no-tree control: ${okBare}/${RUNS} · parent-scoped (no tree): ${okParent}/${RUNS}`);
process.exit(0);
