// The app's options → the app-server's own vocabulary, in ONE place.
//
// `codex exec` takes these as argv, one flag each. The app-server has no argv per turn —
// it is one process for the whole chat — so every option becomes a field on a request
// instead: `sandboxPolicy` and `approvalPolicy` on the turn, `collaborationMode` for
// plan, `config` for feature flags. Getting a mapping wrong is silent (the CLI accepts
// the shape and does something else), so each rule is pinned here against the names and
// enums the server's own generated bindings use.
//
// Run: node agent/test/codexSettings.test.mjs
import assert from "node:assert/strict";
import { sandboxPolicyFor, collaborationModeFor, spawnArgsFor, turnSettingsFor } from "../features/ai/codexSettings.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── sandbox ──

test("each permission mode becomes the sandbox policy the server understands", () => {
  // Probed: the CLI rejects an unknown variant with -32600, so the spelling matters.
  assert.equal(sandboxPolicyFor({ mode: "fullAccess" }).type, "dangerFullAccess");
  assert.equal(sandboxPolicyFor({ mode: "readOnly" }).type, "readOnly");
  assert.equal(sandboxPolicyFor({ mode: "default" }).type, "workspaceWrite");
  assert.equal(sandboxPolicyFor({ mode: "plan" }).type, "workspaceWrite", "plan keeps a writing sandbox and proposes instead");
});

test("the exec transport's sandbox spelling is understood too", () => {
  // The adapter carries `sandboxMode` in exec's spelling ("danger-full-access"). Passing
  // only that used to fall through to the default, so a chat that asked for full access
  // ran as workspace-write — silently, because a tmpdir is writable either way.
  assert.equal(sandboxPolicyFor({ sandbox: "danger-full-access" }).type, "dangerFullAccess");
  assert.equal(sandboxPolicyFor({ sandbox: "read-only" }).type, "readOnly");
  assert.equal(sandboxPolicyFor({ sandbox: "workspace-write" }).type, "workspaceWrite");
});

test("a mode outranks a raw sandbox name when both are given", () => {
  // The mode is the user's own choice; the sandbox name is only how exec spells one.
  assert.equal(sandboxPolicyFor({ mode: "readOnly", sandbox: "danger-full-access" }).type, "readOnly");
});

test("an unknown mode falls back to the write-workspace default, never to full access", () => {
  // Failing open here would hand a typo'd mode the whole disk.
  assert.equal(sandboxPolicyFor({ mode: "nonsense" }).type, "workspaceWrite");
  assert.equal(sandboxPolicyFor({}).type, "workspaceWrite");
});

test("network access rides inside the sandbox policy", () => {
  // The exec path passed it as `-c sandbox_workspace_write.network_access=true`; the
  // server takes it as a field of the same policy object.
  assert.equal(sandboxPolicyFor({ mode: "default", networkAccess: true }).networkAccess, true);
  assert.equal(sandboxPolicyFor({ mode: "default", networkAccess: false }).networkAccess, false);
  assert.equal(sandboxPolicyFor({ mode: "fullAccess", networkAccess: true }).networkAccess, undefined,
    "dangerFullAccess carries no network field — it is already unrestricted");
});

test("extra dirs become writable roots, which is what makes them writable", () => {
  const p = sandboxPolicyFor({ mode: "default", addDirs: ["/tmp/extra", "/tmp/more"] });
  assert.deepEqual(p.writableRoots, ["/tmp/extra", "/tmp/more"]);
  // Verified end to end: a file written into a non-empty writableRoots landed on disk.
  assert.ok(Array.isArray(p.writableRoots));
});

test("the fields the server requires on every workspaceWrite are all present", () => {
  // Checked against SandboxPolicy: omitting one is a deserialize error, not a default.
  const p = sandboxPolicyFor({ mode: "default" });
  for (const k of ["type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]) {
    assert.ok(k in p, `missing ${k}`);
  }
});

// ── plan mode ──

test("plan is a collaboration mode, not a sandbox", () => {
  // Same axis as the exec path's `collaboration_mode="plan"`: it does not widen or
  // narrow what may run, it makes the model propose instead of act.
  const m = collaborationModeFor({ planMode: true, model: "", effort: "medium" });
  assert.equal(m.mode, "plan");
  assert.equal(m.settings.reasoning_effort, "medium");
  assert.equal(collaborationModeFor({ planMode: false }).mode, "default");
});

test("plan effort is separate from the turn's own effort", () => {
  // `plan_mode_reasoning_effort` on the exec side — two knobs, and the plan one only
  // applies while planning.
  const m = collaborationModeFor({ planMode: true, effort: "low", planEffort: "xhigh" });
  assert.equal(m.settings.reasoning_effort, "xhigh");
});

test("the collaboration settings carry a model, empty meaning the server's own", () => {
  // `settings.model` is required by the schema; "" is what the server reads as "default".
  assert.equal(collaborationModeFor({ planMode: true }).settings.model, "");
  assert.equal(collaborationModeFor({ planMode: true, model: "gpt-5.6-luna" }).settings.model, "gpt-5.6-luna");
  assert.equal(collaborationModeFor({ planMode: true }).settings.developer_instructions, null);
});

// ── turn settings ──

test("a turn carries the settings a mode change has to reach mid-chat", () => {
  const t = turnSettingsFor({ mode: "readOnly", effort: "high", personality: "pragmatic", model: "gpt-5.6-luna" });
  assert.equal(t.sandboxPolicy.type, "readOnly");
  assert.equal(t.approvalPolicy, "untrusted");
  assert.equal(t.effort, "high");
  assert.equal(t.personality, "pragmatic");
  assert.equal(t.model, "gpt-5.6-luna");
});

test("only full access answers nothing, and every narrower mode keeps the gate", () => {
  // The gate is the point of a narrow mode. `never` on readOnly would be the app
  // deciding the user does not want to be asked about a write they forbade.
  assert.equal(turnSettingsFor({ mode: "fullAccess" }).approvalPolicy, "never");
  assert.equal(turnSettingsFor({ mode: "readOnly" }).approvalPolicy, "untrusted");
  assert.equal(turnSettingsFor({ mode: "default" }).approvalPolicy, "on-request");
  assert.equal(turnSettingsFor({ mode: "plan" }).approvalPolicy, "on-request");
});

test("empty options are left out rather than sent as null", () => {
  // Sending `model: null` would override the thread's model with nothing.
  const t = turnSettingsFor({ mode: "default" });
  assert.ok(!("model" in t), "an unset model must not be sent");
  assert.ok(!("effort" in t));
  assert.ok(!("personality" in t));
});

// ── spawn-time args ──

test("feature flags are spawn-time: -c features.<name>=true, not a request field", () => {
  // Probed on the real server: `thread/start`'s `config` does NOT apply a feature
  // (read back through experimentalFeature/list it stayed false), and
  // experimentalFeature/enablement/set answered `{}` without changing anything either.
  // Only the process's own flags do.
  const args = spawnArgsFor({ enable: ["multi_agent_v2"], disable: ["artifact"] });
  assert.deepEqual(args, ["-c", "features.multi_agent_v2=true", "-c", "features.artifact=false"]);
});

test("no flags means no args at all, so the server is started plainly", () => {
  assert.deepEqual(spawnArgsFor({}), []);
  assert.deepEqual(spawnArgsFor({ enable: [], disable: [] }), []);
});

test("a feature name is not interpolated unchecked", () => {
  // The value goes into a config override, so anything that could close the expression
  // or start a new one is dropped rather than passed through.
  const args = spawnArgsFor({ enable: ["ok_name", 'bad"=true,x="', "with space", ""] });
  assert.deepEqual(args, ["-c", "features.ok_name=true"]);
});

test("every shared exec flag that has no request field becomes a config override", () => {
  // These rode the exec argv and have no place on thread/start or turn/start.
  const args = spawnArgsFor({ skipGitRepoCheck: true, ephemeral: true });
  assert.ok(args.includes("skip_git_repo_check=true"), `got ${JSON.stringify(args)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
