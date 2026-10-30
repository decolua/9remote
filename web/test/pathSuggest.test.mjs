// Terminal path hint: the arg after a path-taking verb, plus any command that is
// spelled as a path (`git add ./src`). Completions must keep the whole command and
// rank a typed prefix by fuzzy score instead of a bare startsWith.
//
// Run: node --import ./test/loader-alias.mjs web/test/pathSuggest.test.mjs
import assert from "node:assert/strict";
import { parsePathInput, pickMatches } from "../features/terminal/utils/pathSuggest.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running path suggest tests...");

test("a path verb parses into dir + prefix, keeping the command in lead", () => {
  const parsed = parsePathInput("cd src/comp", "/w");
  assert.equal(parsed.lead, "cd ");
  assert.equal(parsed.dir, "/w/src");
  assert.equal(parsed.prefix, "comp");
});

test("any command ending in a spelled-out path parses", () => {
  const parsed = parsePathInput("git add ./src", "/w");
  assert.equal(parsed.lead, "git add ");
  assert.equal(parsed.dir, "/w/.");
  assert.equal(parsed.prefix, "src");
});

test("a plain word after a command is not a path", () => {
  assert.equal(parsePathInput("npm i -g foo", "/w"), null);
});

test("flags and operators never open the hint", () => {
  assert.equal(parsePathInput("git log --oneline", "/w"), null);
});

test("absolute and home roots resolve to themselves", () => {
  assert.equal(parsePathInput("cd /", "/w").dir, "/");
  assert.equal(parsePathInput("cd ~/x", "/w").dir, "~");
});

test("a completion keeps the leading command and the folder", () => {
  const entries = [
    { name: "components", type: "folder" },
    { name: "compile.md", type: "file" }
  ];
  const items = pickMatches(entries, "comp", { partial: "src/comp", lead: "git add " });
  assert.equal(items[0].full, "git add src/components/");
});

test("folders rank above files, then by fuzzy score", () => {
  const entries = [
    { name: "zzz.txt", type: "file" },
    { name: "composer.jsx", type: "file" },
    { name: "compile", type: "folder" }
  ];
  const items = pickMatches(entries, "comp", { partial: "comp", lead: "" });
  assert.deepEqual(items.map((i) => i.name), ["compile", "composer.jsx"]);
});

test("matched offsets point at the typed characters", () => {
  const entries = [{ name: "compile.md", type: "file" }];
  const [item] = pickMatches(entries, "cmp", { partial: "cmp", lead: "" });
  assert.equal(item.positions.map((p) => item.label[p]).join(""), "cmp");
});

test("an empty prefix lists the folder without ranking", () => {
  const entries = [{ name: "b.txt", type: "file" }, { name: "a.txt", type: "file" }];
  const items = pickMatches(entries, "", { partial: "", lead: "" });
  assert.deepEqual(items.map((i) => i.name), ["a.txt", "b.txt"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
