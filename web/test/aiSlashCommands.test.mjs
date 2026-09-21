// The '/' menu builder: host commands win name clashes, live engine commands and
// skills merge in behind them, filter is a lowercase substring on the name.
// Run: node --import ./test/loader-alias.mjs test/aiSlashCommands.test.mjs   (cwd: web/)
import assert from "node:assert/strict";
import { buildSlashItems } from "../features/ai/lib/slashMenu.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const HOST = [
  { name: "/model", description: "host model picker", action: "modal:model" },
  { name: "/clear", description: "host clear", action: "clear" },
];

console.log("Running slash menu builder tests...");

test("live commands are slash-prefixed and flagged", () => {
  const items = buildSlashItems({ staticCommands: [], liveCommands: [{ name: "review", description: "review changes" }], skills: [], filter: "" });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "/review");
  assert.equal(items[0].description, "review changes");
  assert.equal(items[0].isCommand, true);
});

test("host commands win a name clash over live commands and skills", () => {
  const items = buildSlashItems({
    staticCommands: HOST,
    liveCommands: [{ name: "model", description: "engine /model" }, { name: "review", description: "" }],
    skills: [{ name: "clear", description: "skill clear" }],
    filter: "",
  });
  const names = items.map((i) => i.name);
  assert.deepEqual(names, ["/model", "/clear", "/review"]);
  assert.equal(items[0].description, "host model picker", "host entry must survive the clash");
  assert.equal(items[2].isCommand, true);
});

test("skills keep their flag and ride after live commands", () => {
  const items = buildSlashItems({
    staticCommands: [],
    liveCommands: [{ name: "review", description: "" }],
    skills: [{ name: "huashu", description: "design skill" }],
    filter: "",
  });
  assert.equal(items[1].name, "/huashu");
  assert.equal(items[1].isSkill, true);
});

test("filter is a case-insensitive substring on the name", () => {
  const items = buildSlashItems({
    staticCommands: HOST,
    liveCommands: [{ name: "Review", description: "" }],
    skills: [],
    filter: "rev",
  });
  assert.deepEqual(items.map((i) => i.name), ["/Review"]);
});

test("an empty live feed leaves the menu intact", () => {
  const items = buildSlashItems({ staticCommands: HOST, liveCommands: [], skills: [], filter: "" });
  assert.deepEqual(items.map((i) => i.name), ["/model", "/clear"]);
});

test("a live command and a skill with the same name keep the command", () => {
  const items = buildSlashItems({
    staticCommands: [],
    liveCommands: [{ name: "search", description: "engine search" }],
    skills: [{ name: "search", description: "skill search" }],
    filter: "",
  });
  assert.deepEqual(items.map((i) => i.name), ["/search"]);
  assert.equal(items[0].isCommand, true);
  assert.equal(items[0].description, "engine search");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
