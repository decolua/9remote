// Tests for the Codex adapter's argv construction and mode mapping.
// Run: node agent/test/codexAdapter.test.mjs
import assert from "node:assert/strict";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// Builds the argv for one turn without spawning a CLI.
function adapterWith(setup = () => {}) {
  const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: () => {} });
  setup(adapter);
  return adapter;
}

await test("doctor spec is codex's own doctor", () => {
  assert.deepEqual(CodexAdapter.doctorSpec(), { command: "codex", args: ["doctor"] });
});

await test("defaults to the Default preset, not a bypass", () => {
  const args = adapterWith().buildArgs("hi");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("-s") && args[args.indexOf("-s") + 1] === "workspace-write");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

await test("maps each preset to its sandbox, and fullAccess also bypasses approvals", () => {
  const ro = adapterWith((a) => a.setOptions({ mode: "readOnly" })).buildArgs("hi");
  assert.ok(ro.includes("-s") && ro[ro.indexOf("-s") + 1] === "read-only");

  const full = adapterWith((a) => a.setOptions({ mode: "fullAccess" })).buildArgs("hi");
  assert.ok(full.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!full.includes("-s"));
});

await test("plan is a separate axis: it sets collaboration_mode, not the sandbox", () => {
  const a = adapterWith((x) => x.setOptions({ mode: "plan", effort: "high" }));
  assert.equal(a.planMode, true);
  const args = a.buildArgs("hi");
  const i = args.indexOf('collaboration_mode="plan"');
  assert.ok(i > 0 && args[i - 1] === "-c");
  // Plan keeps a writing sandbox — the CLI itself refuses the write in this mode.
  assert.ok(args.includes("-s") && args[args.indexOf("-s") + 1] === "workspace-write");
});

await test("planEffort goes through plan_mode_reasoning_effort, separately from effort", () => {
  const args = adapterWith((a) => a.setOptions({ mode: "plan", effort: "low", planEffort: "xhigh" })).buildArgs("hi");
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('plan_mode_reasoning_effort="xhigh"'));
});

await test("carries the reasoning tier, including xhigh", () => {
  const args = adapterWith((a) => a.setOptions({ effort: "xhigh" })).buildArgs("hi");
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
});

await test("resume uses config overrides, since `exec resume` rejects -s", () => {
  const args = adapterWith((a) => { a.activeThreadId = "t-1"; a.setOptions({ mode: "readOnly" }); }).buildArgs("hi");
  assert.ok(args.includes("resume"));
  assert.ok(!args.includes("-s"));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.equal(args[args.indexOf("resume") + 1], "--json");
  assert.deepEqual(args.slice(-2), ["t-1", "hi"]);
});

await test("resumed turns still carry model, plan mode and effort", () => {
  const args = adapterWith((a) => {
    a.activeThreadId = "t-1";
    a.setOptions({ model: "gpt-5.6-luna", effort: "low", mode: "plan" });
  }).buildArgs("hi");
  assert.ok(args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5.6-luna");
  assert.ok(args.includes('collaboration_mode="plan"'));
  assert.ok(args.includes('model_reasoning_effort="low"'));
});

await test("personality, network access and extra dirs ride on both branches", () => {
  for (const threadId of [null, "t-1"]) {
    const args = adapterWith((a) => {
      a.activeThreadId = threadId;
      a.setOptions({ personality: "pragmatic", networkAccess: true, addDirs: ["/tmp/extra"] });
    }).buildArgs("hi");
    assert.ok(args.includes('personality="pragmatic"'));
    assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
    assert.ok(args.includes("--add-dir") && args[args.indexOf("--add-dir") + 1] === "/tmp/extra");
  }
});

await test("setOptions emits metadata the composer reads back", () => {
  const events = [];
  const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  adapter.setOptions({ mode: "plan", effort: "high", model: "gpt-5.6-luna" });
  const init = events.filter(([e]) => e === "init").pop()[1];
  assert.equal(init.permissionMode, "plan");
  assert.equal(init.planMode, true);
  assert.equal(init.effort, "high");
  assert.equal(init.model, "gpt-5.6-luna");
});

await test("every Config-modal option is echoed on metadata, so reopening shows the truth", () => {
  const events = [];
  const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  const chosen = {
    personality: "friendly",
    networkAccess: true,
    addDirs: ["/tmp/x"],
    enable: ["web_search"],
    disable: ["hooks"],
    skipGitRepoCheck: true,
    ephemeral: true,
    planEffort: "xhigh",
  };
  adapter.setOptions(chosen);
  const init = events.filter(([e]) => e === "init").pop()[1];
  for (const [key, value] of Object.entries(chosen)) {
    assert.deepEqual(init[key], value, `${key} must round-trip through metadata`);
  }
  // A fresh adapter built from that metadata produces the same flags, i.e. reopening
  // the modal and applying without changes cannot silently revert the session.
  const reopened = new CodexAdapter({ cwd: "/tmp", onEvent: () => {} });
  reopened.setOptions(init);
  const args = reopened.buildArgs("hi");
  assert.ok(args.includes('personality="friendly"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(args.includes('plan_mode_reasoning_effort="xhigh"'));
  assert.ok(args.includes("--add-dir") && args.includes("--enable") && args.includes("--disable"));
  assert.ok(args.includes("--skip-git-repo-check") && args.includes("--ephemeral"));
});

await test("a refusal offers a mode that can actually write, never Read Only", () => {
  const refusal = {
    type: "item.completed",
    item: { id: "x", type: "agent_message", text: "I couldn't create proof.txt because this workspace is read-only." }
  };
  const offers = (mode) => {
    const events = [];
    const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
    adapter.setOptions({ mode });
    adapter.handleEvent(refusal);
    const blocked = events.find(([e]) => e === "blocked");
    return blocked?.[1].escalate?.mode || null;
  };
  // Read Only cannot write, so it is never the answer to a blocked write.
  assert.equal(offers("plan"), "default");
  assert.equal(offers("readOnly"), "default");
  assert.equal(offers("default"), "fullAccess");
  // Already unrestricted — nothing to escalate to, and no card to nag with.
  assert.equal(offers("fullAccess"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
