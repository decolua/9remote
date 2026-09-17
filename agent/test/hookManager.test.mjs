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

// All 15 tools are registered
await test("SUPPORTED_TOOLS has 15 tools", () => {
  assert.equal(m.SUPPORTED_TOOLS.length, 15);
});

// Helper: extract the curl command from a nested-json hook entry {hooks:[{command}], matcher?}
const cmd = (entry) => entry?.hooks?.[0]?.command || "";

// Codex addresses a hook as <path>:<event_snake>:<groupIdx>:<handlerIdx>; the test
// stands in for the host's own spelling rather than importing the module's.
const snake = (ev) => ev.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

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

// Cursor: flat-json kind — each entry is {command} directly, no timeout field
await test("cursor writes flat hooks without timeout", () => {
  m.enableToolHook("cursor");
  const settings = JSON.parse(fs.readFileSync(path.join(TMP, ".cursor", "hooks.json"), "utf8"));
  assert.ok(settings.hooks.beforeToolCall[0].command.includes("?type=working"));
  assert.ok(settings.hooks.stop[0].command.includes("?type=done"));
  assert.equal(settings.hooks.beforeToolCall[0].timeout, undefined);
  m.disableToolHook("cursor");
});

// Codex: writes hooks.json handlers (the legacy notify slot only ever said "done",
// which is why a codex terminal's tab never showed working — see the codex suite below).
await test("codex writes handlers into hooks.json, not the legacy notify slot", () => {
  m.enableToolHook("codex");
  const hooks = JSON.parse(fs.readFileSync(path.join(TMP, ".codex", "hooks.json"), "utf8")).hooks;
  assert.ok(cmd(hooks.Stop[0]).includes("?type=done"), "Stop→done written");
  assert.ok(!fs.existsSync(path.join(TMP, ".codex", "9remote-notify.sh")), "no notify wrapper written");
  const toml = fs.existsSync(path.join(TMP, ".codex", "config.toml"))
    ? fs.readFileSync(path.join(TMP, ".codex", "config.toml"), "utf8") : "";
  assert.ok(!toml.includes("# 9Remote notification"), "notify block not written");
  m.disableToolHook("codex");
  const after = JSON.parse(fs.readFileSync(path.join(TMP, ".codex", "hooks.json"), "utf8")).hooks;
  assert.equal(after, undefined, "hooks removed on disable");
});

// OpenCode: JS plugin with start/end events
await test("opencode writes JS plugin with chat.message→working, session.idle→done", () => {
  m.enableToolHook("opencode");
  const plugin = fs.readFileSync(path.join(TMP, ".config", "opencode", "plugin", "nineRemoteNotify.js"), "utf8");
  assert.ok(plugin.includes('"chat.message"'));
  // Each post carries the conversation id alongside the state, so match the call
  // by the state it reports rather than by an exact argument list.
  assert.match(plugin, /post\("working"[,)]/);
  assert.match(plugin, /post\("done"[,)]/);
  assert.match(plugin, /post\("blocked"[,)]/, "permission.asked→blocked");
  assert.ok(plugin.includes("&sessionID="), "reports opencode's own conversation id");
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

// ─── Codex 0.154+ status hooks (hooks.json + trust) ─────────────────────────
// The legacy `notify` slot fires ONE event (`agent-turn-complete`) and passes its
// JSON on argv[2], not stdin — so it can only ever report `done`, never `working`.
// Status now comes from ~/.codex/hooks.json, whose handlers run only once codex
// has a trusted sha256 for each one in config.toml.

const CODEX_HOOKS = path.join(TMP, ".codex", "hooks.json");
const CODEX_TOML = path.join(TMP, ".codex", "config.toml");
const readHooks = () => JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8"));
const readToml = () => fs.readFileSync(CODEX_TOML, "utf8");
// A group is ours iff one of its handlers posts to our notify endpoint for codex.
const ours = (g) => (g?.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("&tool=codex"));

// A foreign hook in the user's file — Orca's shape, which the agent must not disturb.
const FOREIGN = { hooks: [{ type: "command", command: "/bin/sh '/Users/x/.orca/agent-hooks/codex-hook.sh'", timeout: 10 }] };
function seedForeign() {
  const hooks = {};
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PermissionRequest"]) {
    hooks[ev] = [{ ...FOREIGN }];
  }
  fs.mkdirSync(path.dirname(CODEX_HOOKS), { recursive: true });
  fs.writeFileSync(CODEX_HOOKS, JSON.stringify({ hooks }, null, 2));
}

await test("codex enable writes a hooks.json handler for every state event", () => {
  seedForeign();
  const r = m.enableToolHook("codex");
  assert.equal(r.success, true);
  const hooks = readHooks().hooks;
  assert.ok(cmd(hooks.UserPromptSubmit.at(-1)).includes("?type=working"), "UserPromptSubmit→working");
  assert.ok(cmd(hooks.PreToolUse.at(-1)).includes("?type=working"), "PreToolUse→working");
  assert.ok(cmd(hooks.PostToolUse.at(-1)).includes("?type=working"), "PostToolUse→working");
  assert.ok(cmd(hooks.Stop.at(-1)).includes("?type=done"), "Stop→done");
  assert.ok(cmd(hooks.PermissionRequest.at(-1)).includes("?type=blocked"), "PermissionRequest→blocked");
  // Codex reports its own conversation id on the hook payload under `session_id`.
  assert.ok(cmd(hooks.Stop.at(-1)).includes("&csid="), "forwards codex's conversation id");
});

await test("codex enable leaves a foreign hook in place, after ours", () => {
  seedForeign();
  m.enableToolHook("codex");
  const hooks = readHooks().hooks;
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PermissionRequest"]) {
    assert.equal(hooks[ev][0].hooks[0].command, FOREIGN.hooks[0].command, `${ev}: foreign group untouched`);
    assert.ok(ours(hooks[ev][1]), `${ev}: ours appended`);
  }
});

await test("codex enable is idempotent", () => {
  seedForeign();
  m.enableToolHook("codex");
  m.enableToolHook("codex");
  const hooks = readHooks().hooks;
  assert.equal(hooks.Stop.filter(ours).length, 1, "one 9remote group per event");
  assert.equal(hooks.Stop.length, 2, "foreign group neither duplicated nor dropped");
});

await test("codex disable removes only our groups", () => {
  seedForeign();
  fs.writeFileSync(CODEX_TOML, "");
  m.enableToolHook("codex");
  const r = m.disableToolHook("codex");
  assert.equal(r.success, true);
  const hooks = readHooks().hooks;
  assert.equal(hooks.Stop.filter(ours).length, 0, "our group gone");
  assert.equal(hooks.Stop.length, 1, "foreign group survives");
  assert.equal(m.getHookStatus().codex.enabled, false, "reports disabled");
});

await test("codex isEnabled is true only while every event has our hook", () => {
  seedForeign();
  m.enableToolHook("codex");
  assert.equal(m.getHookStatus().codex.enabled, true);
  // Drop one event — a partial install must not read as enabled.
  const hooks = readHooks().hooks;
  hooks.Stop = hooks.Stop.filter((g) => !ours(g));
  fs.writeFileSync(CODEX_HOOKS, JSON.stringify({ hooks }, null, 2));
  assert.equal(m.getHookStatus().codex.enabled, false);
});

// The trust key is codex's own addressing: <path>:<event_snake>:<groupIdx>:<handlerIdx>.
await test("codex trust writes a trusted_hash under codex's own key", async () => {
  seedForeign();
  m.enableToolHook("codex");
  const seen = [];
  const r = await m.reconcileCodexHookTrust({
    run: async () => {
      const hooks = readHooks().hooks;
      // Stand in for `hooks/list` — codex answers a hash per handler it discovered.
      return Object.entries(hooks).flatMap(([ev, groups]) =>
        groups.map((g, i) => (ours(g) ? { key: `${CODEX_HOOKS}:${snake(ev)}:${i}:0`, hash: `sha256:${snake(ev)}-${i}` } : null))
      ).filter(Boolean);
    }
  });
  seen.push(r);
  const toml = readToml();
  // Our group sits at index 1 (the foreign one holds 0), which must appear in the key.
  assert.ok(toml.includes(`[hooks.state."${CODEX_HOOKS}:stop:1:0"]`), "key names the group's real index");
  assert.ok(toml.includes('trusted_hash = "sha256:stop-1"'), "hash written");
  assert.deepEqual(r.missing, [], "nothing left untrusted");
});

await test("codex trust leaves foreign hooks.state entries alone", async () => {
  seedForeign();
  m.enableToolHook("codex");
  fs.writeFileSync(CODEX_TOML, `[hooks.state."${CODEX_HOOKS}:stop:0:0"]\ntrusted_hash = "sha256:foreign"\n`);
  await m.reconcileCodexHookTrust({ run: async () => [{ key: `${CODEX_HOOKS}:stop:1:0`, hash: "sha256:mine" }] });
  const toml = readToml();
  assert.ok(toml.includes('trusted_hash = "sha256:foreign"'), "foreign entry intact");
  assert.ok(toml.includes('trusted_hash = "sha256:mine"'), "ours added");
});

await test("codex trust works when config.toml does not exist yet", async () => {
  seedForeign();
  fs.rmSync(CODEX_TOML, { force: true });
  m.enableToolHook("codex");
  // Every handler sits at group index 1 (the foreign group holds 0), so report them all,
  // the way codex's own hooks/list answers.
  const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PermissionRequest"];
  const r = await m.reconcileCodexHookTrust({
    run: async () => events.map((ev) => ({ key: `${CODEX_HOOKS}:${snake(ev)}:1:0`, hash: `sha256:${snake(ev)}` }))
  });
  const toml = readToml();
  assert.ok(toml.includes("[hooks.state."), "config.toml created with the trust entry");
  assert.ok(toml.includes(`[hooks.state."${CODEX_HOOKS}:user_prompt_submit:1:0"]`), "every event trusted");
  assert.deepEqual(r.missing, [], "nothing left untrusted");
});

// A key codex did not report cannot be trusted — and saying so beats a hook that
// silently never runs, which is the whole failure this path exists to end.
await test("codex trust reports a key codex did not answer for", async () => {
  seedForeign();
  fs.rmSync(CODEX_TOML, { force: true });
  m.enableToolHook("codex");
  const r = await m.reconcileCodexHookTrust({ run: async () => [] });
  assert.ok(r.missing.length > 0, "untrusted keys surfaced");
  assert.ok(!fs.existsSync(CODEX_TOML), "nothing written on an empty answer");
});

// A user who ran an older agent still has the dead notify block in config.toml. It can
// only ever write a second, redundant `done` per turn, so enabling cleans it out — and
// puts back the notify line we had commented over.
await test("codex enable clears the legacy notify block and restores the user's line", () => {
  fs.mkdirSync(path.join(TMP, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".codex", "9remote-notify.sh"), "#!/bin/sh\n");
  fs.writeFileSync(CODEX_TOML, [
    'model = "gpt-5"',
    "# 9Remote-saved: notify = [\"say\", \"done\"]",
    "",
    "# 9Remote notification",
    'notify = ["bash", "/tmp/9remote-notify.sh", "9remote"]',
    "",
    "[features]",
    "x = true",
    "",
  ].join("\n"));
  m.enableToolHook("codex");
  const toml = readToml();
  assert.ok(!toml.includes("# 9Remote notification"), "legacy block gone");
  assert.ok(toml.includes('notify = ["say", "done"]'), "user's own notify line restored");
  assert.ok(!toml.includes("9remote-notify.sh"), "no reference to the wrapper");
  assert.ok(!fs.existsSync(path.join(TMP, ".codex", "9remote-notify.sh")), "wrapper script removed");
  assert.ok(toml.includes("[features]"), "the rest of the file untouched");
  assert.ok(toml.includes('model = "gpt-5"'), "head preserved");
});

// The saved line may be OUR OWN notify: an enable that ran while our block was already
// in the slot commented it over. Restoring that would point config.toml at the wrapper
// this same call deletes.
await test("codex enable drops a saved notify that was ours all along", () => {
  fs.mkdirSync(path.join(TMP, ".codex"), { recursive: true });
  const wrapper = path.join(TMP, ".codex", "9remote-notify.sh");
  fs.writeFileSync(wrapper, "#!/bin/sh\n");
  fs.writeFileSync(CODEX_TOML, [
    "# 9Remote-saved: notify = [ \"bash\", \"" + wrapper + "\", \"9remote\" ]",
    "",
    "# 9Remote notification",
    `notify = ["bash", "${wrapper}", "9remote"]`,
    "",
    "[features]",
    "x = true",
    "",
  ].join("\n"));
  m.enableToolHook("codex");
  const toml = readToml();
  assert.ok(!toml.includes("9remote-notify.sh"), "no dangling reference to the deleted wrapper");
  assert.ok(!toml.includes("notify"), "no notify line left at all");
  assert.ok(toml.includes("[features]"), "rest of the file intact");
});

// An earlier run of this cleanup can leave the restored line behind with no block beside
// it — the removal must not be gated on the block still being there.
await test("codex enable drops a stray notify line left by an earlier cleanup", () => {
  fs.mkdirSync(path.join(TMP, ".codex"), { recursive: true });
  fs.writeFileSync(CODEX_TOML, [
    'model = "gpt-5"',
    'notify = [ "bash", "' + path.join(TMP, ".codex", "9remote-notify.sh") + '", "9remote" ]',
    "",
    "[features]",
    "x = true",
    "",
  ].join("\n"));
  m.enableToolHook("codex");
  const toml = readToml();
  assert.ok(!toml.includes("notify"), "stray notify line removed");
  assert.ok(toml.includes('model = "gpt-5"'), "head preserved");
  assert.ok(toml.includes("[features]"), "rest preserved");
});

// Trust keys are positional, so removing our group renumbers whatever followed it. The
// foreign group's trust must survive that shift — dropping it would stop the user's own
// hook from running as a side effect of us tidying up.
await test("codex disable keeps a foreign trust entry through the index shift", () => {
  seedForeign();
  m.enableToolHook("codex");
  fs.writeFileSync(CODEX_TOML, [
    `[hooks.state."${CODEX_HOOKS}:stop:0:0"]`,
    'trusted_hash = "sha256:foreign"',
    `[hooks.state."${CODEX_HOOKS}:stop:1:0"]`,
    'trusted_hash = "sha256:mine"',
    "",
  ].join("\n"));
  m.disableToolHook("codex");
  const toml = readToml();
  assert.ok(toml.includes('trusted_hash = "sha256:foreign"'), "foreign trust survives");
  assert.ok(!toml.includes("sha256:mine"), "our trust entry removed");
});

// getHookStatus reports installed=false when binary missing (temp HOME has no PATH binaries)
await test("getHookStatus reports every tool", () => {
  const status = m.getHookStatus();
  assert.equal(Object.keys(status).length, 15);
  for (const t of m.SUPPORTED_TOOLS) assert.ok(status[t].installed === false || status[t].installed === true);
});

console.log(`\n${fail ? `❌ ${fail} failed` : "✅ all passed"}, ${pass} passed`);
// Cleanup temp HOME
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
if (fail) process.exit(1);
