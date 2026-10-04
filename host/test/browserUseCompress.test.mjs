// TDD + benchmark: observation-compression renderers vs the live payload shape.
// Run: node host/test/browserUseCompress.test.mjs
// Unit tests pin each algorithm's contract; the benchmark feeds snapshot-shaped
// fixtures through buildActionSpace/buildQuestions (the REAL current payload is
// the baseline) and ranks renderers by chars / est-tokens / 24-step run cost.
import assert from "node:assert/strict";
import { buildActionSpace, buildQuestions } from "../features/browserUse/agentLoop.js";
import { PLAN_MAX, MAX_STEPS_DEFAULT } from "../features/browserUse/constants.js";
import {
  minUniquePrefixes, groupByPath, collapseRuns, renderTreeLines, RENDERERS
} from "../features/browserUse/compress.js";

// ---- fixtures: snapshot-shaped pages covering the shapes real sites give ----

const action = (i, role, label, kind, ctx, extra = {}) => ({
  id: `e${i}`, node: i, role, label, kind, ctx, value: "",
  path: ctx ? ctx.split(" > ") : undefined, ...extra
});

const FIXTURES = [
  { name: "login-small", gen: () => [
    action(1, "textbox", "Username", "fill", "Main > Sign in"),
    action(2, "textbox", "Password", "fill", "Main > Sign in"),
    action(3, "link", "Forgot password?", "click", "Main > Sign in"),
    action(4, "button", "Sign in", "click", "Main > Sign in"),
    action(5, "button", "Sign in with SSO", "click", "Main > Sign in"),
    action(6, "link", "Create account", "click", "Footer"),
    action(7, "link", "Terms", "click", "Footer"),
    action(8, "link", "Privacy", "click", "Footer")
  ] },
  { name: "form-long", gen: () => Array.from({ length: 30 }, (_, i) =>
    action(i + 1, "textbox", `Field ${String(i + 1).padStart(2, "0")}`, "fill", "Main > Registration")
  ).concat([
    action(31, "button", "Submit", "click", "Main > Registration"),
    action(32, "button", "Reset", "click", "Main > Registration")
  ]) },
  { name: "dashboard-dense", gen: () => {
    const out = [];
    let i = 1;
    for (let w = 1; w <= 15; w++) {
      const ctx = `Main > Widget ${String(w).padStart(2, "0")}`;
      out.push(action(i++, "heading", `Widget ${w} revenue`, "click", ctx));
      for (const label of ["Refresh", "Configure", "Share", "Delete", "Export"]) {
        out.push(action(i++, "button", label, "click", ctx));
      }
    }
    return out;
  } },
  { name: "product-grid", gen: () => {
    const out = [];
    let i = 1;
    for (let p = 1; p <= 42; p++) {
      const ctx = `Main > Results > Row ${Math.ceil(p / 3)}`;
      out.push(action(i++, "link", `Product ${String(p).padStart(3, "0")} name with a longer tail`, "click", ctx));
      out.push(action(i++, "button", "Add to cart", "click", ctx));
      out.push(action(i++, "link", `$${9 + (p % 90)}.99`, "click", ctx));
      out.push(action(i++, "button", "Add to wishlist", "click", ctx));
      out.push(action(i++, "combobox", "Quantity", "click", ctx));
    }
    return out;
  } },
  { name: "settings-toggles", gen: () => {
    const out = [];
    let i = 1;
    const sections = ["Notifications", "Privacy", "Appearance", "Advanced"];
    for (const sec of sections) {
      for (let t = 1; t <= 16; t++) {
        out.push(action(i++, "checkbox", `Enable option ${t}`, "click", `Main > Settings > ${sec}`,
          { checked: "true" }));
      }
    }
    return out;
  } },
  { name: "nav-heavy", gen: () => {
    const out = [];
    let i = 1;
    const groups = ["Docs", "API", "Guides", "Blog"];
    for (const g of groups) {
      for (let n = 1; n <= 22; n++) {
        out.push(action(i++, "link", `${g} article number ${n} title`, "click", `Nav > ${g}`));
      }
    }
    return out;
  } },
  { name: "data-table", gen: () => {
    const out = [];
    let i = 1;
    for (let r = 1; r <= 30; r++) {
      const ctx = `Main > Invoices > Row ${r}`;
      out.push(action(i++, "link", `INV-2026-${String(r).padStart(4, "0")}`, "click", ctx));
      out.push(action(i++, "button", "Edit", "click", ctx));
      out.push(action(i++, "button", "Delete", "click", ctx));
    }
    return out;
  } },
  { name: "portal-mixed", gen: () => {
    const out = [];
    let i = 1;
    out.push(action(i++, "textbox", "Search everything", "fill", "Header"));
    for (const label of ["Home", "Projects", "Reports", "Team", "Billing", "Settings", "Help"]) {
      out.push(action(i++, "link", label, "click", "Nav > Main"));
    }
    for (let c = 1; c <= 10; c++) {
      const ctx = `Main > Dashboard > Card ${c}`;
      out.push(action(i++, "button", "Reload", "click", ctx));
      out.push(action(i++, "button", "Reload", "click", ctx));
      out.push(action(i++, "link", `Card ${c} detail`, "click", ctx));
      out.push(action(i++, "textbox", `Note for card ${c}`, "fill", ctx));
      out.push(action(i++, "combobox", "Sort by", "click", ctx));
    }
    return out;
  } },
  { name: "search-results", gen: () => {
    const out = [];
    let i = 1;
    for (let r = 1; r <= 25; r++) {
      const ctx = `Main > Results > Hit ${r}`;
      out.push(action(i++, "link", `Search result ${String(r).padStart(2, "0")} — some page title`, "click", ctx));
      out.push(action(i++, "link", `https://result-${r}.example.com/path`, "click", ctx));
      out.push(action(i++, "button", "Open", "click", ctx));
      out.push(action(i++, "button", "Open in new tab", "click", ctx));
    }
    return out;
  } },
  { name: "wizard-step", gen: () => {
    const out = [];
    let i = 1;
    for (let s = 1; s <= 6; s++) {
      const ctx = `Main > Wizard > Step ${s}`;
      out.push(action(i++, "textbox", `Answer for question ${s}`, "fill", ctx));
      out.push(action(i++, "radio", `Option ${s}a`, "click", ctx));
      out.push(action(i++, "radio", `Option ${s}b`, "click", ctx));
      out.push(action(i++, "radio", `Option ${s}c`, "click", ctx));
      out.push(action(i++, "combobox", `Rating ${s}`, "click", ctx));
    }
    out.push(action(i++, "button", "Next step", "click", "Main > Wizard"));
    out.push(action(i++, "button", "Back", "click", "Main > Wizard"));
    out.push(action(i++, "button", "Cancel", "click", "Main > Wizard"));
    return out;
  } },
  { name: "pricing-plans", gen: () => {
    const out = [];
    let i = 1;
    for (const plan of ["Starter", "Pro", "Business", "Enterprise"]) {
      const ctx = `Main > Plans > ${plan}`;
      out.push(action(i++, "radio", `Bill monthly for ${plan}`, "click", ctx));
      out.push(action(i++, "radio", `Bill yearly for ${plan}`, "click", ctx));
      out.push(action(i++, "button", `Choose ${plan}`, "click", ctx));
      out.push(action(i++, "link", `${plan} plan details`, "click", ctx));
    }
    return out;
  } },
  { name: "social-feed", gen: () => {
    const out = [];
    let i = 1;
    for (let p = 1; p <= 20; p++) {
      const ctx = `Main > Feed > Post ${p}`;
      out.push(action(i++, "link", `@user${String(p).padStart(3, "0")}`, "click", ctx));
      out.push(action(i++, "button", "Like", "click", ctx));
      out.push(action(i++, "button", "Share", "click", ctx));
      out.push(action(i++, "button", "Comment", "click", ctx));
      out.push(action(i++, "button", "More options", "click", ctx));
    }
    return out;
  } },
  { name: "gallery", gen: () => {
    const out = [];
    let i = 1;
    for (const chip of ["Recent", "Popular", "Edited", "Shared", "Trash"]) {
      out.push(action(i++, "button", `Filter: ${chip}`, "click", "Sidebar > Filters"));
    }
    for (let g = 1; g <= 60; g++) {
      out.push(action(i++, "button", `Open image ${String(g).padStart(3, "0")}`, "click", "Main > Gallery"));
    }
    return out;
  } },
  { name: "menu-deep", gen: () => {
    const out = [];
    let i = 1;
    for (let a = 1; a <= 4; a++) {
      for (let b = 1; b <= 4; b++) {
        for (let c = 1; c <= 3; c++) {
          out.push(action(i++, "link", `Section ${a}.${b}.${c} overview`, "click",
            `Nav > Section ${a} > Subsection ${b} > Group ${c}`));
        }
      }
    }
    return out;
  } },
  { name: "sparse-minimal", gen: () => [
    action(1, "link", "Enter site", "click", "Page"),
    action(2, "link", "Accessibility statement", "click", "Footer")
  ] },
  // Real-HN shape: uniform-role rows (all links), no path wrappers — only the
  // cycle collapse gives this page any structure.
  { name: "hn-table", gen: () => {
    const out = [];
    let i = 1;
    out.push(action(i++, "link", "Hacker News", "click", "Page"));
    for (let r = 1; r <= 20; r++) {
      out.push(action(i++, "link", "upvote", "click", "Page"));
      out.push(action(i++, "link", `Article ${String(r).padStart(2, "0")}: some discussion title`, "click", "Page"));
      out.push(action(i++, "link", "comments", "click", "Page"));
    }
    out.push(action(i++, "link", "More", "click", "Page"));
    return out;
  } },
  // Position-free labels: the target is defined ONLY by its path — flat
  // renderers without path info must rely on meaningless ordinals here.
  { name: "nested-sections", gen: () => {
    const out = [];
    let i = 1;
    const sections = ["Preferences > Profile", "Preferences > Notifications",
      "Preferences > Privacy", "Security > Sessions"];
    for (const sec of sections) {
      for (let r = 1; r <= 6; r++) {
        const ctx = `Main > ${sec} > Row ${r}`;
        out.push(action(i++, "link", "Open", "click", ctx));
        out.push(action(i++, "button", "Edit", "click", ctx));
        out.push(action(i++, "button", "Remove", "click", ctx));
      }
    }
    return out;
  } },
  { name: "tree-menu-ambiguous", gen: () => {
    const out = [];
    let i = 1;
    const tree = {
      Workspace: ["Files", "Settings", "Members"],
      Admin: ["Users", "Billing"],
      Personal: ["Profile", "Keys"]
    };
    for (const [group, leaves] of Object.entries(tree)) {
      for (const leaf of leaves) {
        out.push(action(i++, "link", "Open", "click", `Nav > ${group} > ${leaf}`));
        out.push(action(i++, "link", "Open", "click", `Nav > ${group} > ${leaf}`));
      }
    }
    return out;
  } },
  { name: "tabs-in-cards", gen: () => {
    const out = [];
    let i = 1;
    for (let c = 1; c <= 4; c++) {
      for (const tab of ["General", "Advanced", "Logs"]) {
        const ctx = `Main > Card ${c} > Tab ${tab}`;
        out.push(action(i++, "textbox", "Name", "fill", ctx));
        out.push(action(i++, "button", "Save", "click", ctx));
        out.push(action(i++, "button", "Cancel", "click", ctx));
      }
    }
    return out;
  } },
  // Depth-5 hard cases: labels identical everywhere, targets defined by a long
  // path with same-named siblings at several levels.
  { name: "deep-tree-5", gen: () => {
    const out = [];
    let i = 1;
    for (const zone of ["Zone A", "Zone B"]) {
      for (let s = 1; s <= 2; s++) {
        for (let g = 1; g <= 2; g++) {
          for (let item = 1; item <= 2; item++) {
            const ctx = `Main > ${zone} > Section ${s} > Group ${g} > Item ${item}`;
            out.push(action(i++, "link", "Open", "click", ctx));
            out.push(action(i++, "button", "Edit", "click", ctx));
            out.push(action(i++, "button", "Remove", "click", ctx));
          }
        }
      }
    }
    return out;
  } },
  { name: "deep-same-siblings", gen: () => {
    const out = [];
    let i = 1;
    for (const zone of ["Alpha", "Beta"]) {
      for (const area of ["General", "Integrations"]) {
        for (const panel of ["Basic", "Advanced"]) {
          const ctx = `Main > Settings > Zone ${zone} > ${area} > ${panel}`;
          out.push(action(i++, "button", "Save", "click", ctx));
          out.push(action(i++, "button", "Cancel", "click", ctx));
          out.push(action(i++, "button", "Reset", "click", ctx));
        }
      }
    }
    return out;
  } },
  { name: "deep-cycle-hybrid", gen: () => {
    const out = [];
    let i = 1;
    const cats = { Electronics: ["Sonos", "Sonys"], Appliances: ["Bosch", "Miele"] };
    for (const [cat, brands] of Object.entries(cats)) {
      for (const brand of brands) {
        for (const model of ["Pro", "Lite"]) {
          for (let r = 1; r <= 6; r++) {
            const ctx = `Shop > ${cat} > ${brand} > ${model} > Offers > Row ${r}`;
            out.push(action(i++, "link", "View", "click", ctx));
            out.push(action(i++, "button", "Buy", "click", ctx));
            out.push(action(i++, "button", "Compare", "click", ctx));
          }
        }
      }
    }
    return out;
  } }
];

const pageOf = (name) => ({
  url: `https://example.com/${name}`,
  title: name.replace(/-/g, " "),
  text: "Page body text sample. ".repeat(40).slice(0, 900),
  headings: ["Overview", "Details", "Footer"],
  scroll: { y: 0, height: 2400 }
});

// Renderers experiment on the raw snapshot actions (same shape snapshot.js
// returns, minus rect); the LIVE baseline below uses the real pipeline.
const renderStateOf = (fixture) => ({ ...pageOf(fixture.name), elements: fixture.gen() });

// The live payload buildQuestions produces — what decide() actually posts.
function baselineChars(fixture) {
  const space = buildActionSpace(fixture.gen());
  const body = buildQuestions(pageOf(fixture.name), "complete the task", [], space);
  return JSON.stringify({ state: body.state, questions: body.questions }).length;
}

// ---- unit contracts -----------------------------------------------------------

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("compress unit contracts...");

test("minUniquePrefixes cuts at the divergence point", () => {
  assert.deepEqual(
    minUniquePrefixes(["Delete account", "Delete session", "Deploy"]),
    ["Delete a", "Delete s", "Depl"]
  );
});

test("minUniquePrefixes: proper prefix keeps full, ordinal for exact dupes", () => {
  assert.deepEqual(minUniquePrefixes(["Delete", "Delete account"]), ["Delete", "Delete a"]);
  assert.deepEqual(minUniquePrefixes(["Save", "Save", "Save"]), ["Save", "Save (2)", "Save (3)"]);
  assert.deepEqual(minUniquePrefixes(["Go", "Go to"]), ["Go", "Go t"]);
});

test("groupByPath groups by key, sections in first-appearance order", () => {
  const items = [
    { id: "e1", path: ["Main", "Form"] },
    { id: "e2", path: ["Nav"] },
    { id: "e3", path: ["Main", "Form"] }
  ];
  const groups = groupByPath(items, (el) => el.path.join(" > "));
  assert.deepEqual(groups.map((g) => g.path), ["Main > Form", "Nav"]);
  assert.deepEqual(groups[0].items.map((el) => el.id), ["e1", "e3"]);
  assert.equal(groupByPath([{ id: "e9" }], (el) => el.path?.join(" > "))[0].path, "Page");
});

test("collapseRuns only merges CONSECUTIVE same-signature items", () => {
  const sig = (el) => `${el.role}|${el.kind}`;
  const runs = collapseRuns([
    { role: "button", kind: "click" }, { role: "button", kind: "click" },
    { role: "link", kind: "click" },
    { role: "button", kind: "click" }
  ], sig);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => r.items.length), [2, 1, 1]);
});

test("renderers preserve the choice invariants on every fixture", () => {
  for (const fixture of FIXTURES) {
    const state = renderStateOf(fixture);
    const ids = new Set(state.elements.map((el) => el.id));
    for (const [name, render] of Object.entries(RENDERERS)) {
      const { body, labels } = render(state);
      assert.equal(labels.size, ids.size, `${name}/${fixture.name}: lost an id from the label map`);
      for (const id of ids) assert.ok(body.includes(id), `${name}/${fixture.name}: id ${id} missing from body`);
      assert.equal(new Set(labels.values()).size, labels.size, `${name}/${fixture.name}: labels not injective`);
    }
  }
});

test("tree renderers indent by path depth", () => {
  const state = renderStateOf(FIXTURES[0]);
  const lines = RENDERERS["tree-yaml"](state).body.split("\n");
  assert.ok(lines.some((l) => /e\d+ /.test(l) && l.startsWith("    ")), "no depth-2 element line in the tree");
});

test("collapsed renderer detects interleaved cycles (table rows)", () => {
  const state = renderStateOf(FIXTURES.find((f) => f.name === "data-table"));
  const { body } = RENDERERS["flat-collapsed"](state);
  assert.match(body, /row ×30 \[link, button "Edit", button "Delete"\]/);
  assert.match(body, /e1 INV-2026-0001 · e2 · e3/);
});

test("collapsed renderer emits dense id lists for identical-label runs", () => {
  const custom = {
    name: "dense-buttons",
    gen: () => Array.from({ length: 12 }, (_, i) =>
      action(i + 1, "button", "Add to cart", "click", "Main > Results"))
  };
  const { body } = RENDERERS["flat-collapsed"](renderStateOf(custom));
  assert.match(body, /"Add to cart" ×12: e1( e\d+){11}/);
});

// ---- cycle-collapse inside the tree (the live renderTreeLines path) -----------

// Mixed-role rows (like real tables/grids): sig-based cycle detection needs
// the row shape to repeat — uniform-role rows (HN: all links) stay uncollapsed.
const hnRow = (i) => ([
  action(i, "button", "upvote", "click", "Page"),
  action(i + 1, "link", `Article ${Math.floor(i / 3) + 1} title`, "click", "Page"),
  action(i + 2, "link", "comments", "click", "Page")
]);

test("renderTreeLines collapses row cycles inside a section", () => {
  const elements = Array.from({ length: 20 }, (_, r) => hnRow(r * 3 + 1)).flat();
  const body = renderTreeLines(elements);
  assert.match(body, /row ×20 \[button "upvote", link, link "comments"\]/);
  assert.match(body, /e1 · e2 Article 1 title · e3/);
  for (const el of elements) assert.ok(body.includes(el.id), `${el.id} missing`);
});

test("cycle collapse survives stragglers before and after the run", () => {
  const stragglerBefore = action(1, "link", "Hacker News", "click", "Page");
  const rows = Array.from({ length: 15 }, (_, r) => hnRow(r * 3 + 2)).flat();
  const stragglerAfter = action(47, "link", "More", "click", "Page");
  const body = renderTreeLines([stragglerBefore, ...rows, stragglerAfter]);
  assert.match(body, /row ×15 \[/);
  assert.match(body, /e47 link "More"/);
  assert.ok(body.includes("e1 link \"Hacker News\""));
});

test("tree does not merge cycles across different sections", () => {
  const a = hnRow(1).map((el) => ({ ...el, path: ["Nav"] }));
  const b = hnRow(4).map((el) => ({ ...el, path: ["Main"] }));
  const body = renderTreeLines([...a, ...b]);
  assert.ok(!/row ×/.test(body), "cycles merged across sections");
  assert.match(body, /Nav:/);
  assert.match(body, /Main:/);
});

test("live buildQuestions tree carries the collapse", () => {
  const rows = Array.from({ length: 12 }, (_, r) => hnRow(r * 3 + 1)).flat();
  const space = buildActionSpace(rows);
  const body = buildQuestions(
    { url: "https://x", title: "t", text: "", actions: rows }, "goal", [], space);
  assert.match(body.state.page.tree, /row ×12 \[/);
});

test("uniform-role rows with repeating labels still collapse (HN shape)", () => {
  const hnUniformRow = (i) => ([
    action(i, "link", "upvote", "click", "Page"),
    action(i + 1, "link", `Article ${Math.floor(i / 3) + 1} title`, "click", "Page"),
    action(i + 2, "link", "comments", "click", "Page")
  ]);
  const rows = Array.from({ length: 20 }, (_, r) => hnUniformRow(r * 3 + 1)).flat();
  const body = renderTreeLines(rows);
  assert.match(body, /row ×20 \[link "upvote", link, link "comments"\]/);
});

test("a flat run of unique labels never collapses into a pseudo-cycle", () => {
  const links = Array.from({ length: 18 }, (_, i) =>
    action(i + 1, "link", `Nav item ${i + 1}`, "click", "Nav"));
  const body = renderTreeLines(links);
  assert.ok(!/row ×/.test(body), "unique labels formed a fake cycle");
  assert.match(body, /e18 link "Nav item 18"/);
});

// ---- benchmark ----------------------------------------------------------------

console.log("\nbenchmark (chars, est tokens = chars/4, run = 24 steps @ PLAN_MAX batch)...");
const RUN_CALLS = Math.ceil(MAX_STEPS_DEFAULT / PLAN_MAX);
const rows = [];
for (const fixture of FIXTURES) {
  const state = renderStateOf(fixture);
  const base = baselineChars(fixture);
  for (const [name, render] of Object.entries(RENDERERS)) {
    const { body } = render(state);
    rows.push({ fixture: fixture.name, renderer: name, chars: body.length,
      pct: Math.round((body.length / base) * 100) });
  }
  rows.push({ fixture: fixture.name, renderer: "LIVE buildQuestions", chars: base, pct: 100 });
}

const names = [...Object.keys(RENDERERS), "LIVE buildQuestions"];
const COL = 19;
console.log("\n" + "fixture".padEnd(18) + names.map((n) => n.padStart(COL)).join(""));
for (const fixture of FIXTURES) {
  const byName = Object.fromEntries(rows.filter((r) => r.fixture === fixture.name).map((r) => [r.renderer, r]));
  console.log(fixture.name.padEnd(18) + names.map((n) =>
    `${byName[n].pct}%`.padStart(COL)).join(""));
}

const totals = names.map((n) => ({
  name: n,
  chars: rows.filter((r) => r.renderer === n).reduce((a, r) => a + r.chars, 0)
}));
const baseTotal = totals.find((t) => t.name === "LIVE buildQuestions").chars;
totals.sort((a, b) => a.chars - b.chars);
console.log("\nTOTAL across fixtures (lower is better):");
for (const t of totals) {
  console.log(`  ${(100 * t.chars / baseTotal).toFixed(0).padStart(4)}%  ` +
    `~${Math.round(t.chars / 4).toLocaleString()} tok/page  ${t.name}`);
}
const winner = totals[0];
console.log(`\nwinner for Jev: ${winner.name} — ${(100 - 100 * winner.chars / baseTotal).toFixed(0)}% ` +
  `smaller than the live payload; a 24-step run re-sends it ${RUN_CALLS}× (batch PLAN_MAX=${PLAN_MAX}).`);

assert.ok(totals[0].chars < baseTotal, "no renderer beat the live payload — benchmark is broken");

// ---- real-Jev accuracy + token benchmark (JEV_BENCH=1, free lane) --------------
// Same pattern as BROWSER_USE_E2E_REAL: offline by default, opt-in for live calls.
// Each renderer's compact body becomes state.page.text; criteria come from the
// renderer's own label map; Jev must pick the scripted target id. usage tokens
// are the provider's own count — the chars/4 proxy gets a ground-truth check.

if (process.env.JEV_BENCH === "1") {
  const { decide, validateChoice } = await import("../features/browserUse/jevClient.js");
  const GOALS = [
    { fixture: "product-grid", goal: "Add product 017 to the cart", expect: "e82" },
    { fixture: "data-table", goal: "Delete invoice INV-2026-0022", expect: "e66" },
    // Structural goals: target defined by PATH only (labels identical everywhere)
    { fixture: "nested-sections", goal: "Remove the item in row 3 of the Notifications preferences", expect: "e27" },
    { fixture: "tree-menu-ambiguous", goal: "Open the link inside Workspace then Settings", expect: "e3" },
    { fixture: "tabs-in-cards", goal: "Press Save on the Logs tab of Card 2", expect: "e17" },
    // Depth-5 hard goals — path-carrying renderers only
    { fixture: "deep-tree-5", only: ["flat-all", "flat-grouped", "tree-yaml"],
      goal: "Open the item in Zone B, Section 2, Group 1, Item 2", expect: "e40" },
    { fixture: "deep-same-siblings", only: ["flat-all", "flat-grouped", "tree-yaml"],
      goal: "Press Reset in the Advanced panel of the Integrations area of Zone Beta", expect: "e24" },
    { fixture: "deep-cycle-hybrid", only: ["flat-all", "flat-grouped", "tree-yaml"],
      goal: "Buy the third offer of the Pro model by Sonys in Electronics", expect: "e44" },
    // The LIVE payload (tree + cycle, exactly what runTask posts) on the page
    // shape only the cycle collapse can structure
    { fixture: "hn-table", only: ["live-json-state", "tree-yaml", "flat-collapsed"],
      goal: "Open the comments thread of Article 14", expect: "e43" }
  ];
  console.log("\nreal-Jev benchmark (JEV_BENCH=1)...");
  const liveResults = [];
  for (const { fixture: fixtureName, goal, expect, only = null } of GOALS) {
    const fixture = FIXTURES.find((f) => f.name === fixtureName);
    const state = renderStateOf(fixture);
    const space = buildActionSpace(fixture.gen());
    const variants = [
      ...Object.entries(RENDERERS).map(([name, render]) => {
        const { body, labels } = render(state);
        return { name, body, labels };
      }),
      {
        name: "live-json-state",
        body: null,
        labels: new Map([...Object.values(space.targets).flatMap((m) => Object.values(m))]
          .map((a) => [a.id, a.label])),
        // pageOf has no actions field — without it buildQuestions renders an
        // empty tree and the variant stops representing the live payload
        liveState: buildQuestions({ ...pageOf(fixtureName), actions: fixture.gen() }, goal, [], space).state
      }
    ];
    for (const variant of variants) {
      if (only && !only.includes(variant.name)) continue;
      const criteria = Object.fromEntries(variant.labels);
      const body = {
        state: variant.liveState ?? {
          page: { url: state.url, title: state.title, text: variant.body },
          elements: [], recent_actions: []
        },
        questions: {
          pick: {
            type: "choice",
            criteria,
            instructions: { goal, rules: "Choose the element id that satisfies the goal." }
          }
        }
      };
      const started = Date.now();
      try {
        // Free lane rate-limits bursts; OpenRouter (same systemone schema) is the default.
        const result = await decide(body, { preset: process.env.JEV_PRESET || "openrouter" });
        const answer = validateChoice(result.answers.pick || {}, Object.keys(criteria));
        assert.ok(answer, `${variant.name}: Jev answer failed validation`);
        const usage = result.usage || {};
        const tokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? "?";
        const correct = answer.choice === expect;
        const ms = Date.now() - started;
        liveResults.push({ fixture: fixtureName, variant: variant.name, correct });
        console.log(`  ${fixtureName.padEnd(14)} ${variant.name.padEnd(18)} ` +
          `${String(tokens).padStart(7)} tok  ${String(ms).padStart(5)} ms  ` +
          `${correct ? "✓" : `✗ picked ${answer.choice}`}`);
      } catch (e) {
        liveResults.push({ fixture: fixtureName, variant: variant.name, correct: false });
        console.log(`  ${fixtureName.padEnd(14)} ${variant.name.padEnd(18)} ERROR ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const correctCount = liveResults.filter((r) => r.correct).length;
  console.log(`\nreal-Jev accuracy: ${correctCount}/${liveResults.length} correct picks`);
} else {
  console.log("\n(real-Jev accuracy benchmark skipped — run with JEV_BENCH=1)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
