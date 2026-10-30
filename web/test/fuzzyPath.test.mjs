// `@` file mentions and the terminal path hint share one ranker. These pin the rules
// a coder feels directly: a basename hit beats a folder-only hit, boundaries beat
// mid-word hits, capitals turn matching case-sensitive, folder drills stay scoped,
// and the token follows the caret instead of the end of the prompt.
//
// Run: node web/test/fuzzyPath.test.mjs
import assert from "node:assert/strict";
import {
  scoreText,
  scorePath,
  rankPaths,
  tokenAtCaret,
  formatMention
} from "../shared/utils/fuzzyPath.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running fuzzy path tests...");

const index = {
  files: [
    { path: "web/features/terminal/utils/pathSuggest.js", isModified: false },
    { path: "web/shared/components/ui/CommandSuggestions.js", isModified: false },
    { path: "web/features/ai/components/Composer.jsx", isModified: true },
    { path: "docs/compile.md", isModified: false },
    { path: "src/PathSuggestion.js", isModified: false }
  ],
  dirs: ["docs", "src", "web", "web/features", "web/features/ai", "web/features/terminal"]
};

const paths = (hits) => hits.map((h) => h.path);

test("subsequence matches even when characters are spread out", () => {
  const hit = scoreText("cmpj", "Composer.jsx");
  assert.ok(hit, "expected a match");
  assert.deepEqual(hit.positions.map((p) => "Composer.jsx"[p]), ["C", "m", "p", "j"]);
});

test("a query that is not a subsequence is rejected", () => {
  assert.equal(scoreText("composez", "Composer.jsx"), null);
});

test("a boundary hit beats a mid-word hit", () => {
  const boundary = scoreText("su", "pathSuggest.js");
  const middle = scoreText("su", "issue.txt");
  assert.ok(boundary.score > 0 && middle == null || boundary.score > middle.score);
});

test("a basename hit outranks a hit that only lands on folders", () => {
  const onBase = scorePath("suggest", "web/features/terminal/utils/pathSuggest.js");
  const onDir = scorePath("suggest", "src/suggestions/util.js");
  assert.ok(onBase.score > 0);
  assert.ok(onDir === null || onBase.score > onDir.score);
});

test("an exact basename scores above a prefix of the same name", () => {
  const exact = scorePath("pathSuggest.js", "web/utils/pathSuggest.js");
  const prefix = scorePath("pathSuggest", "web/utils/pathSuggest.old.js");
  assert.ok(exact.score > 0);
  assert.ok(!prefix || exact.score > prefix.score);
});

test("capitals make matching case-sensitive (smart case)", () => {
  assert.ok(scorePath("Composer", "web/Composer.jsx"), "capital query should match");
  assert.equal(scorePath("COMPOSER", "web/Composer.jsx"), null, "wrong case must be rejected");
  assert.ok(scorePath("composer", "web/Composer.jsx"), "lowercase query stays case-insensitive");
});

test("rankPaths puts a basename hit above a folder-only hit", () => {
  const ranked = rankPaths(index, "suggest", 5);
  assert.ok(ranked.length > 0);
  const first = ranked[0];
  assert.ok(first.path.toLowerCase().includes("suggest"), `got ${first.path}`);
  assert.ok(first.path.includes("pathSuggest.js") || first.path.includes("PathSuggestion.js"), `got ${first.path}`);
});

test("rankPaths prefers a shallower path when the match is equal", () => {
  const ranked = rankPaths(index, "suggestion", 5);
  assert.equal(ranked[0].path, "src/PathSuggestion.js");
});

test("rankPaths ranks locally, so a deep exact name still surfaces", () => {
  const ranked = rankPaths(index, "composer", 5);
  assert.equal(ranked[0].path, "web/features/ai/components/Composer.jsx");
});

test("a query with a folder keeps completion inside that folder", () => {
  const ranked = rankPaths(index, "web/features/t", 5);
  assert.ok(ranked.length > 0);
  for (const hit of ranked) assert.ok(hit.path.startsWith("web/features/t"), hit.path);
});

test("drilling into a folder lists each child once, not once per file below it", () => {
  const ranked = rankPaths(index, "web/features/", 5);
  const paths = ranked.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes("web/features/ai"));
});

test("typing a full segment name lands on that child", () => {
  const ranked = rankPaths(index, "web/features/ai", 3);
  assert.equal(ranked[0].path, "web/features/ai");
  assert.ok(ranked[0].isDir);
});

test("a folder with no match falls back to whole-path fuzzy instead of dying", () => {
  const ranked = rankPaths(index, "web/nope/composer", 5);
  assert.ok(ranked.length > 0, "fallback should still answer");
});

test("an empty query lists changed files first, then shallow paths", () => {
  const ranked = rankPaths(index, "", 5);
  assert.equal(ranked[0].path, "web/features/ai/components/Composer.jsx");
  assert.ok(ranked.every((r) => r.positions.length === 0));
});

test("a modified file gets the tiebreak bonus", () => {
  const plain = scorePath("composer", "a/Composer.jsx");
  const changed = scorePath("composer", "a/Composer.jsx", { isModified: true });
  assert.ok(changed.score > plain.score);
});

test("token follows the caret, not the end of the prompt", () => {
  const text = "fix @Composer.jsx menu";
  const hit = tokenAtCaret(text, "fix @Composer".length);
  assert.ok(hit);
  assert.equal(hit.trigger, "@");
  assert.equal(hit.query, "Composer");
  assert.equal(hit.start, "fix ".length);
});

test("a token that merely ends with a space is not a mention", () => {
  assert.equal(tokenAtCaret("hello @Composer ", 16), null);
});

test("a second @ (email, decorator) does not open the picker", () => {
  assert.equal(tokenAtCaret("mail me at a@b", 14), null);
});

test("slash commands still resolve at the caret", () => {
  const hit = tokenAtCaret("/mod rest", 4);
  assert.equal(hit.trigger, "/");
  assert.equal(hit.query, "mod");
});

test("paths with spaces are escaped so the mention stays one argument", () => {
  assert.equal(formatMention("My Docs/read me.md"), "My\\ Docs/read\\ me.md");
});

test("an escaped space stays inside the mention token, and unescapes for matching", () => {
  const text = "open @My\\ Docs/re";
  const hit = tokenAtCaret(text, text.length);
  assert.ok(hit);
  assert.equal(hit.query, "My Docs/re");
  assert.equal(hit.start, "open ".length);
});

test("highlight offsets point at the real characters in the path", () => {
  const hit = rankPaths(index, "comp", 1)[0];
  const chars = hit.positions.map((p) => hit.path[p]).join("");
  assert.equal(chars.toLowerCase(), "comp");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
