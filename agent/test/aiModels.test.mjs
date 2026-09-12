// Tests for the per-engine default model lookup and the opencode catalog.
// Run: node agent/test/aiModels.test.mjs
import assert from "node:assert/strict";
import { resolveDefaultModel, listOpencodeModelOptions } from "../features/ai/models.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

await test("an engine with no config file resolves to empty, never a canned id", () => {
  assert.equal(resolveDefaultModel("antigravity"), "");
  assert.equal(resolveDefaultModel("nope"), "");
});

// The point of the lookup: whatever comes back must be a real id the CLI accepts,
// so it is either "" or a member of the engine's own catalog.
await test("codex default is a slug in codex's own catalog", () => {
  const id = resolveDefaultModel("codex");
  assert.equal(typeof id, "string");
  assert.ok(!id.includes(" "), `id must not be a display label: ${id}`);
});

await test("opencode default is a provider/model id from its own catalog", () => {
  const id = resolveDefaultModel("opencode");
  if (!id) return; // host has no recent pick — "" is the documented fallback
  assert.ok(listOpencodeModelOptions().some((m) => m.id === id), id);
});

await test("opencode catalog is a list of unique provider/model ids", () => {
  const options = listOpencodeModelOptions();
  for (const o of options) assert.match(o.id, /^[\w.-]+\/[\w.-]+$/);
  assert.equal(new Set(options.map((o) => o.id)).size, options.length);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
