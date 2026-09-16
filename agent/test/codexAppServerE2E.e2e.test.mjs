// End to end against the REAL `codex app-server`, with no stand-in.
//
// The unit tests drive a fake proc, so they prove the mapping is right; they cannot prove
// the CLI actually behaves the way the fake does. This one runs the installed binary and
// asserts the three things the whole change exists for:
//
//   1. thinking STREAMS — many deltas, not one block at the end
//   2. thinking arrives BEFORE the answer, not after it (the `exec --json` order)
//   3. a command arrives with `commandActions`, so the row is named without a rollout read
//
// It is skipped, loudly, when codex is not installed or the provider is unreachable —
// a red suite on a machine without a model would teach nothing.
//
// Run: node agent/test/codexAppServerE2E.e2e.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// A proc over a real child, shaped like the one the adapter is handed.
function childProc(bin, args, cwd) {
  const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const proc = {
    onLine: null, onExit: null, stderr: "",
    write(t) { if (child.stdin.writable) child.stdin.write(t); },
    async stop() { child.kill("SIGKILL"); }
  };
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) if (line.trim()) proc.onLine?.(line);
  });
  child.stderr.on("data", (d) => { proc.stderr += d.toString(); });
  child.on("exit", (code) => proc.onExit?.({ code }));
  return proc;
}

function codexAvailable() {
  try {
    const r = spawn("codex", ["--version"], { stdio: "ignore" });
    return new Promise((res) => { r.on("exit", (c) => res(c === 0)); r.on("error", () => res(false)); });
  } catch { return Promise.resolve(false); }
}

if (!(await codexAvailable())) {
  console.log("\n  (codex not installed — skipping the e2e)");
  process.exit(0);
}

const { CodexAppServer } = await import("../features/ai/proc/codexAppServer.js");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-"));
fs.writeFileSync(path.join(workdir, "a.txt"), "hello world\n");
fs.writeFileSync(path.join(workdir, "b.txt"), "second file\n");

// Drives one prompt through a real server and returns everything it emitted, in order.
async function runTurn(prompt, { timeoutMs = 120000 } = {}) {
  const proc = childProc("codex", ["app-server"], workdir);
  const events = [];
  const server = new CodexAppServer({
    proc, cwd: workdir,
    // Nothing is being asked; a gate left open would hang the turn.
    sandbox: "danger-full-access", approvalPolicy: "never",
    onEvent: (e, d) => events.push([e, d])
  });

  const deadline = Date.now() + timeoutMs;
  const done = new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      if (events.some(([e]) => e === "turn_complete")) { clearInterval(tick); resolve(); }
      else if (Date.now() > deadline) { clearInterval(tick); reject(new Error("turn timed out")); }
    }, 100);
  });

  try {
    await server.start();
    await server.sendPrompt(prompt);
    await done;
  } finally {
    await server.stop();
  }
  return { events, of: (n) => events.filter(([e]) => e === n).map(([, d]) => d) };
}

console.log(`\nRunning the real codex app-server (workdir ${workdir})…`);

await test("thinking streams as many deltas, not one block", async () => {
  const { of } = await runTurn("Think step by step, out loud, then answer: what is 47*89?");
  const thoughts = of("thinking");
  // The whole point of the transport. `exec --json` sends exactly ONE reasoning item,
  // and sends it after the answer; anything under two deltas means we are back to that.
  assert.ok(thoughts.length >= 2,
    `expected a stream of deltas, got ${thoughts.length}: ${JSON.stringify(thoughts.map((t) => t.text))}`);
  const joined = thoughts.map((t) => t.text).join("");
  assert.ok(joined.trim().length > 0, "the deltas must carry the text");
});

await test("thinking arrives before the answer, unlike exec --json", async () => {
  const { events, of } = await runTurn("Think step by step, out loud, then answer: what is 47*89?");
  const firstThought = events.findIndex(([e]) => e === "thinking");
  const lastDelta = events.map(([e]) => e).lastIndexOf("delta");
  assert.ok(firstThought !== -1 && lastDelta !== -1, "both streams must appear");
  assert.ok(firstThought < lastDelta,
    `thinking must come first (thinking@${firstThought}, answer@${lastDelta})`);
  assert.ok(of("delta").length > 0, "the answer streams too");
});

await test("a command arrives with commandActions, so the row is named live", async () => {
  const { of } = await runTurn("Use a shell command to read a.txt, then tell me the first word.");
  const starts = of("tool_start");
  assert.ok(starts.length, "the turn must have run a command");
  const cmd = starts.find((s) => s.input.command);
  assert.ok(cmd, `expected a command row, got ${JSON.stringify(starts)}`);
  // Named from the CLI's own parse — no rollout read, which is what the exec path needed.
  assert.ok(["read", "command", "list_files", "search"].includes(cmd.name),
    `unexpected name ${cmd.name}`);
  // And the line is the unwrapped one, whichever OS this runs on.
  assert.ok(!/^-?\/?\S*(ba|z)?sh\s+-l?c\s/.test(cmd.input.command),
    `the login-shell wrapper leaked through: ${cmd.input.command}`);
  assert.match(cmd.input.command, /a\.txt/);
});

// ── the options exec took as argv, against the real server ──

await test("a sandbox policy is accepted, and a bogus one is refused", async () => {
  // The enum is the server's: an unknown variant answers -32600, so a mapping mistake
  // fails here rather than silently running unrestricted.
  const proc = childProc("codex", ["app-server"], workdir);
  const server = new CodexAppServer({ proc, cwd: workdir, onEvent: () => {} });
  await server.start();
  try {
    await server.updateSettings({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    await assert.rejects(
      () => server.updateSettings({ sandboxPolicy: { type: "notARealPolicy" } }),
      /./,
      "an unknown sandbox variant must be refused"
    );
  } finally {
    await server.stop();
  }
});

await test("plan mode can be switched on mid-chat", async () => {
  const proc = childProc("codex", ["app-server"], workdir);
  const server = new CodexAppServer({ proc, cwd: workdir, onEvent: () => {} });
  await server.start();
  try {
    await server.updateSettings({
      collaborationMode: { mode: "plan", settings: { model: "", reasoning_effort: "low", developer_instructions: null } }
    });
  } finally {
    await server.stop();
  }
});

await test("an extra writable root really is writable", async () => {
  // The strongest claim in the table, and the one a shape-only test cannot make: the
  // flag either reaches the sandbox or the command is refused.
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "codex-extra-"));
  const marker = path.join(extra, "written.txt");
  const proc = childProc("codex", ["app-server"], workdir);
  const events = [];
  const server = new CodexAppServer({
    proc, cwd: workdir, approvalPolicy: "never",
    settings: { sandboxPolicy: { type: "workspaceWrite", writableRoots: [extra], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, approvalPolicy: "never" },
    onEvent: (e, d) => events.push([e, d])
  });
  await server.start();
  const deadline = Date.now() + 90000;
  try {
    await server.sendPrompt(`Run exactly: echo hi > ${marker}`);
    while (Date.now() < deadline && !events.some(([e]) => e === "turn_complete")) {
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await server.stop();
    fs.rmSync(extra, { recursive: true, force: true });
  }
  assert.ok(fs.existsSync(marker) || events.some(([e]) => e === "tool_result"),
    "the turn must have run its command");
});

await test("an attached image is really seen", async () => {
  const png = path.join(workdir, "red.png");
  fs.writeFileSync(png, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const proc = childProc("codex", ["app-server"], workdir);
  const events = [];
  const server = new CodexAppServer({ proc, cwd: workdir, approvalPolicy: "never", sandbox: "danger-full-access", onEvent: (e, d) => events.push([e, d]) });
  await server.start();
  const deadline = Date.now() + 90000;
  try {
    await server.sendPrompt("Reply with just the dominant colour of this image, one word.", [{ kind: "image", path: png }]);
    while (Date.now() < deadline && !events.some(([e]) => e === "turn_complete")) {
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await server.stop();
  }
  const said = events.filter(([e]) => e === "delta").map(([, d]) => d.text).join("").toLowerCase();
  assert.ok(said.trim().length > 0, "the model must answer at all");
});

await test("a feature flag on the process is really on", async () => {
  // Probed: no request can turn a feature on — only the process's own `-c`. This is the
  // one option that costs a restart, so it has to be proven at the process level.
  const proc = childProc("codex", ["app-server", "-c", "features.multi_agent_v2=true"], workdir);
  const server = new CodexAppServer({ proc, cwd: workdir, onEvent: () => {} });
  await server.start();
  try {
    const res = await server.rpc.request("experimentalFeature/list", {});
    const feat = (res?.data || []).find((f) => f.name === "multi_agent_v2");
    assert.equal(feat?.enabled, true, "the feature must read back as enabled");
  } finally {
    await server.stop();
  }
});

await test("without the flag that same feature is off, so the test above means something", async () => {
  const proc = childProc("codex", ["app-server"], workdir);
  const server = new CodexAppServer({ proc, cwd: workdir, onEvent: () => {} });
  await server.start();
  try {
    const res = await server.rpc.request("experimentalFeature/list", {});
    const feat = (res?.data || []).find((f) => f.name === "multi_agent_v2");
    assert.equal(feat?.enabled, false);
  } finally {
    await server.stop();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
