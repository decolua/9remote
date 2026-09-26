// Tests for the per-engine default model/effort lookup and the opencode catalog.
// Run: node agent/test/aiModels.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// A host routed through a provider it declared itself (`model_provider` → a
// [model_providers.*] block) must not be offered OpenAI's catalog — those slugs 404
// through the gateway. Profiles from its own config are offered either way.
await test("codex options: profiles always, official catalog only when not custom-routed", () => {
  const options = listCodexModelOptions();
  const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  const provider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(text.split(/^\s*\[/m)[0] || "")?.[1] || "";
  const custom = Boolean(provider) && provider !== "openai" && text.includes(`[model_providers.${provider}]`);
  if (custom) {
    assert.ok(options.every((o) => o.provider === "profiles"));
  } else {
    assert.ok(options.some((o) => o.id === "gpt-5.6-sol"));
  }
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
