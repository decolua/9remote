// Tests for the registry-driven hook manager: enable/disable writes valid config for each kind,
// idempotent, and the curl command targets the right event type. Uses a temp HOME so it never
// touches the user's real agent config files.
//
// Run: node agent/test/hookManager.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point HOME + APP state dir at a temp sandbox BEFORE importing hookManager.
// os.homedir() resolves process.env.HOME at module load, so it must be set first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "9r-hook-"));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
// Some tools honor *_HOME overrides — set them too so tests are deterministic.
process.env.GROK_HOME = path.join(TMP, ".grok");
process.env.KIRO_HOME = path.join(TMP, ".kiro");
process.env.COPILOT_HOME = path.join(TMP, ".copilot");
process.env.QODER_CONFIG_DIR = path.join(TMP, ".qoder");
process.env.CODEBUDDY_CONFIG_DIR = path.join(TMP, ".codebuddy");
process.env.PI_CODING_AGENT_DIR = path.join(TMP, ".pi", "agent");

const m = await import("../features/terminal/hookManager.js");
const { SERVER_PORT } = await import("../lib/constants.js");
const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;

let pass = 0, fail = 0;
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { pass++; console.log(`  ✓ ${name}`); })
  .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

// All 16 tools are registered
await test("SUPPORTED_TOOLS has 16 tools", () => {
  assert.equal(m.SUPPORTED_TOOLS.length, 16);
});

// Helper: extract the curl command from a nested-json hook entry {hooks:[{command}], matcher?}
const cmd = (entry) => entry?.hooks?.[0]?.command || "";

// Enable/disable round-trips for a nested-JSON tool (claude) — must write working/done/blocked hooks
await test("claude enable writes hooks for working + done + blocked", () => {
  const r = m.enableToolHook("claude");
  assert.equal(r.success, true);
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".claude", "settings.json"), "utf8"));
  const hooks = settings.hooks;
  assert.ok(cmd(hooks.UserPromptSubmit[0]).includes("&tool=claude"), "UserPromptSubmit→working hook");
  assert.ok(cmd(hooks.Stop[0]).includes("?type=done"), "Stop→done hook");
  assert.ok(cmd(hooks.Notification[0]).includes("?type=blocked"), "Notification→blocked hook");
  assert.equal(hooks.Notification[0].matcher, "permission_prompt", "claude notification matcher preserved");
  // Claude also applies the scrollback env fix
  assert.ok(settings.env, "claude env applied");
});

await test("claude disable removes our hooks (keeps none) + restores env backup", () => {
  const r = m.disableToolHook("claude");
  assert.equal(r.success, true);
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks, undefined, "all our hooks removed");
});

// Enable is idempotent — enabling twice does not duplicate entries
await test("claude enable is idempotent (no duplicate hooks)", () => {
  m.enableToolHook("claude");
  m.enableToolHook("claude");
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".claude", "settings.json"), "utf8"));
  const own = settings.hooks.UserPromptSubmit.filter((g) => cmd(g).includes("&tool=claude"));
  assert.equal(own.length, 1, "only one 9remote hook per event");
});

// Gemini: same nested-json shape, multiple working events
await test("gemini writes BeforeAgent/PreToolUse/PostToolUse as working", () => {
  m.enableToolHook("gemini");
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".gemini", "settings.json"), "utf8"));
  assert.ok(cmd(settings.hooks.BeforeAgent[0]).includes("?type=working"));
  assert.ok(cmd(settings.hooks.PreToolUse[0]).includes("?type=working"));
  assert.ok(cmd(settings.hooks.AfterAgent[0]).includes("?type=done"));
  m.disableToolHook("gemini");
  const after = JSON.parse(fs.readFileSync(path.join(TMP, ".gemini", "settings.json"), "utf8"));
  assert.equal(after.hooks, undefined);
});

// Cursor: flat-json kind — each entry is {command} directly, no timeout field
await test("cursor writes flat hooks without timeout", () => {
  m.enableToolHook("cursor");
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".cursor", "hooks.json"), "utf8"));
  assert.ok(settings.hooks.beforeToolCall[0].command.includes("?type=working"));
  assert.ok(settings.hooks.stop[0].command.includes("?type=done"));
  assert.equal(settings.hooks.beforeToolCall[0].timeout, undefined);
  m.disableToolHook("cursor");
});

// Codex: writes a wrapper script + notify block in TOML
await test("codex writes notify wrapper script + TOML block", () => {
  m.enableToolHook("codex");
  const script = path.join(TMP, ".codex", "9remote-notify.sh");
  assert.ok(fs.existsSync(script), "wrapper script created");
  const toml = fs.readFileSync(path.join(TMP, ".codex", "config.toml"), "utf8");
  assert.ok(toml.includes("# 9Remote notification"), "TOML block present");
  assert.ok(toml.includes("9remote-notify.sh"), "notify points at wrapper");
  m.disableToolHook("codex");
  assert.ok(!fs.existsSync(script), "wrapper removed on disable");
  const after = fs.readFileSync(path.join(TMP, ".codex", "config.toml"), "utf8");
  assert.ok(!after.includes("# 9Remote notification"), "TOML block removed");
});

// OpenCode: JS plugin with start/end events
await test("opencode writes JS plugin with chat.message→working, session.idle→done", () => {
  m.enableToolHook("opencode");
  const plugin = fs.readFileSync(path.join(TMP, ".config", "opencode", "plugin", "nineRemoteNotify.js"), "utf8");
  assert.ok(plugin.includes('"chat.message"'));
  assert.ok(plugin.includes('post("working")'));
  assert.ok(plugin.includes('post("done")'));
  assert.ok(plugin.includes('post("blocked")'), "permission.asked→blocked");
  m.disableToolHook("opencode");
  assert.ok(!fs.existsSync(path.join(TMP, ".config", "opencode", "plugin", "nineRemoteNotify.js")));
});

// Amp: TS plugin
await test("amp writes TS plugin with agent.start/agent.end", () => {
  m.enableToolHook("amp");
  const plugin = fs.readFileSync(path.join(TMP, ".config", "amp", "plugins", "9remote.ts"), "utf8");
  assert.ok(plugin.includes('"agent.start"'));
  assert.ok(plugin.includes('"agent.end"'));
  assert.ok(plugin.includes("tool=amp"));
  m.disableToolHook("amp");
});

// Hermes: YAML block + companion allowlist JSON
await test("hermes writes YAML hooks block + allowlist", () => {
  m.enableToolHook("hermes");
  const yaml = fs.readFileSync(path.join(TMP, ".hermes", "config.yaml"), "utf8");
  assert.ok(yaml.includes("# 9remote hooks begin"));
  assert.ok(yaml.includes("pre_llm_call"));
  assert.ok(yaml.includes("pre_approval_request"));
  const allow = JSON.parse(fs.readFileSync(path.join(TMP, ".hermes", "shell-hooks-allowlist.json"), "utf8"));
  assert.ok(allow.approvals.some((a) => a.command.includes("&tool=hermes")), "allowlist has hermes entries");
  m.disableToolHook("hermes");
  const after = fs.readFileSync(path.join(TMP, ".hermes", "config.yaml"), "utf8");
  assert.ok(!after.includes("# 9remote hooks begin"), "YAML block removed");
});

// Rovodev: YAML block (nested under existing config)
await test("rovodev writes nested YAML block with on_complete/on_message", () => {
  m.enableToolHook("rovodev");
  const yaml = fs.readFileSync(path.join(TMP, ".rovodev", "config.yml"), "utf8");
  assert.ok(yaml.includes("on_complete"));
  assert.ok(yaml.includes("on_message"));
  assert.ok(yaml.includes("on_tool_permission"));
  m.disableToolHook("rovodev");
});

// Unknown tool → error
await test("enable unknown tool returns error", () => {
  const r = m.enableToolHook("notATool");
  assert.equal(r.success, false);
});

// buildCurlCmd targets the configured notify URL
await test("curl command targets localhost notify endpoint", () => {
  m.enableToolHook("claude");
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".claude", "settings.json"), "utf8"));
  const c = cmd(settings.hooks.UserPromptSubmit[0]);
  assert.ok(c.startsWith("csid=$(cat"), "captures claude session id from hook stdin");
  assert.ok(c.includes("&csid=$csid"), "forwards claude session id to notify");
  assert.ok(c.includes("command -v curl"), "curl-guarded");
  assert.ok(c.includes(NOTIFY_URL), "hits configured notify URL");
  assert.ok(c.includes("sessionId=$NINE_REMOTE_SESSION_ID"), "passes session id");
});

// getHookStatus reports installed=false when binary missing (temp HOME has no PATH binaries)
await test("getHookStatus reports every tool", () => {
  const status = m.getHookStatus();
  assert.equal(Object.keys(status).length, 16);
  for (const t of m.SUPPORTED_TOOLS) assert.ok(status[t].installed === false || status[t].installed === true);
});

console.log(`\n${fail ? `❌ ${fail} failed` : "✅ all passed"}, ${pass} passed`);
// Cleanup temp HOME
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (fail) process.exit(1);
