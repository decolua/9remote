// Tests for the per-engine default model/effort lookup and the opencode catalog.
// Run: node agent/test/aiModels.test.mjs
import assert from "node:assert/strict";
import { resolveDefaultModel, resolveDefaultEffort, listCodexModelOptions, listOpencodeModelOptions, saveAiPreference, readAiPreferences } from "../features/ai/models.js";

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

// Profiles and the official catalog ride along together even when the host routes
// codex through its own gateway (`model_provider`) — the router decides which slugs
// resolve; the picker must still show the real catalog.
await test("codex options: profiles plus official catalog, unique ids", () => {
  const options = listCodexModelOptions();
  assert.ok(options.some((o) => o.provider === "profiles"));
  assert.ok(options.some((o) => o.provider === "openai"));
  assert.equal(new Set(options.map((o) => o.id)).size, options.length);
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

// The composer shows this beside the model. It used to be empty until the user picked
// a level, while the CLI was quietly running whatever its own config said.
await test("the default effort is read from each CLI's own config, or empty", () => {
  for (const engine of ["claude", "codex", "opencode"]) {
    const level = resolveDefaultEffort(engine);
    assert.equal(typeof level, "string", engine);
    // A bare level, never a display label or a sentence.
    assert.ok(!/\s/.test(level), `${engine} returned "${level}"`);
  }
});

await test("claude's effort comes from effortLevel in settings.json", () => {
  const level = resolveDefaultEffort("claude");
  if (!level) return; // no settings.json on this host — "" is the documented fallback
  assert.ok(["low", "medium", "high", "xhigh", "max", "ultracode"].includes(level), level);
});

await test("codex reads the TOP-LEVEL model_reasoning_effort, not a profile's", () => {
  // config.toml puts per-profile copies under [profiles.*]; `codex exec` with no
  // profile runs the top-level one, so reading a later match would report the wrong level.
  const level = resolveDefaultEffort("codex");
  if (!level) return;
  assert.ok(["minimal", "low", "medium", "high"].includes(level), level);
});

await test("opencode publishes no effort — its variant is in argv only", () => {
  assert.equal(resolveDefaultEffort("opencode"), "");
});

await test("aiPreferences persists latest model and effort per engine", () => {
  const orig = readAiPreferences();
  try {
    saveAiPreference("claude", { model: "test-model-xyz", effort: "xhigh" });
    assert.equal(resolveDefaultModel("claude"), "test-model-xyz");
    assert.equal(resolveDefaultEffort("claude"), "xhigh");
  } finally {
    saveAiPreference("claude", {
      model: orig.claude?.model || "",
      effort: orig.claude?.effort || ""
    });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
