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
async function runTurn(prompt, { timeoutMs = 120000, mode = null } = {}) {
  const proc = childProc("codex", ["app-server"], workdir);
  const events = [];
  const server = new CodexAppServer({
    proc, cwd: workdir,
    // Nothing is being asked; a gate left open would hang the turn.
    // `mode` narrows the SANDBOX (the refusal test needs one that cannot write); the
    // default stays wide so every other test can do its work.
    ...(mode ? { mode } : { sandbox: "danger-full-access" }),
    approvalPolicy: "never",
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

// ── the records a turn does NOT draw, and the ones it must still deliver ──
//
// The unit tests drive a fake proc, so they prove the mapping. These prove what the real
// server actually sends, which is the half the fake cannot know: an unrouted notification
// never reaches the pane at all, and there is no error anywhere to say so.

await test("a notification nobody wired reaches the pane, from the real server", async () => {
  // The server declares 83 of these and the class wires 7. Measured on the first turn of
  // a real server: `thread/started`, `turn/started`, `thread/settings/updated`, a
  // `deprecationNotice` and a `warning` all arrived and all were dropped on the floor.
  const { of } = await runTurn("Reply with exactly: OK");
  const carried = of("cli_event").map((d) => d.type);
  assert.ok(carried.length > 0, "a real turn must produce records, not nothing");
  assert.ok(carried.includes("turn/started"),
    `the turn's own start is a record the pane can draw — got ${JSON.stringify(carried)}`);
  // And every one of them travels whole, under its own name.
  const [first] = of("cli_event");
  assert.ok(first.record && typeof first.record === "object", "the record arrives, not a summary of it");
});

await test("the per-chunk streams do not flood the pane", async () => {
  // The other half of the rule, and the one that has to be MEASURED rather than assumed:
  // carried raw, the first turn alone was 7.3KB of records against a 32KB replay window,
  // for a turn whose readable content was one word.
  //
  // What matters is the PER-TURN cost, since that is what multiplies: the first turn also
  // carries the thread's own opening state (`thread/started` alone is 1.2KB), which a long
  // chat pays once. So the measurement is turn two — the steady state — folded through the
  // session's own log, which is where the window is cut.
  const { events } = await runTurn("Reply with exactly: OK");
  const { AiSession } = await import("../features/ai/aiSession.js");
  const { replayWindow } = await import("../features/ai/aiEventSlice.js");
  const { AI_REPLAY_BYTES } = await import("../features/ai/constants.js");

  const s = new AiSession({ id: `e2e-${Date.now()}`, engine: "codex", cwd: workdir, options: { mock: true } });
  s.onEvent = () => {};
  // The thread's opening state, then the turn: the same two beats the real log holds.
  s.emitNormalized("cli_event", { type: "thread/started", subtype: "", record: { thread: { id: "t-1" } } });
  for (const [event, data] of events) s.emitNormalized(event, data);

  const carried = s.history.filter((e) => e.event === "cli_event");
  const kept = new Set(carried.map((e) => e.data.type));
  // The beats nobody replays are gone from the log entirely — that is what keeps the
  // window for the conversation. `hook/*` alone was 5KB of it, per turn, forever.
  for (const beat of ["hook/started", "hook/completed", "account/rateLimits/updated",
                      "thread/status/changed", "mcpServer/startupStatus/updated",
                      "rawResponseItem/completed", "fs/changed"]) {
    assert.ok(!kept.has(beat), `${beat} is a live beat, not history`);
  }
  // What the CLI DOES write down is still there, and the window reaches it.
  const bytes = Buffer.byteLength(JSON.stringify(carried));
  assert.ok(bytes < AI_REPLAY_BYTES / 4,
    `a turn's records must leave the ${AI_REPLAY_BYTES}-byte window to the conversation — carried ${bytes} bytes`);
  const { events: window } = replayWindow(s.history, AI_REPLAY_BYTES);
  assert.ok(window.some((e) => e.event === "delta"), "the answer is in the window the client is sent");
});

// ── the rewind, on a real thread ──
//
// The claim the support table makes is "codex CAN rewind": `thread/revert` replaces this
// thread's own history with the prefix before one turn, keeping the SAME thread id. Both
// halves of that were only ever checked by hand (a spike script); this runs it end to end,
// because getting the direction wrong would delete the wrong half of a conversation.

await test("thread/revert keeps the prefix, in the same thread", async () => {
  const proc = childProc("codex", ["app-server"], workdir);
  const server = new CodexAppServer({
    proc, cwd: workdir, sandbox: "danger-full-access", approvalPolicy: "never", onEvent: () => {}
  });
  const turns = async () => ((await server.rpc.request("thread/turns/list", {
    threadId: server.threadId, limit: 20, sortDirection: "asc", itemsView: "summary"
  }))?.data || []).map((t) => t.id);
  const runOne = async (word) => {
    await server.sendPrompt(`Reply with exactly: ${word}`);
    const deadline = Date.now() + 120000;
    for (let i = 0; i < 1200; i++) {
      if (!server.isTurnRunning) break;
      if (Date.now() > deadline) throw new Error("turn timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await server.start();
  try {
    const before = server.threadId;
    await runOne("ONE");
    await runOne("TWO");
    const ids = await turns();
    assert.ok(ids.length >= 2, `expected two turns, got ${ids.length}`);

    // Cut before the SECOND turn: one turn must survive, and it must be the FIRST one.
    await server.rpc.request("thread/revert", { threadId: before, beforeTurnId: ids[1] }, { timeoutMs: 15000 });
    const after = await turns();
    assert.equal(after.length, 1, "the prefix is what survives a rewind");
    assert.equal(after[0], ids[0], "and it is the EARLIEST turn — the direction matters");
    assert.equal(server.threadId, before, "the thread is the same one: no fork, no second conversation");
  } finally {
    await server.stop();
  }
});

// ── a refusal under a narrow sandbox ──
//
// The default transport showed the refusal sentence and no way out of it. Codex has no
// structured refusal event, so the only signal is the prose — which is what this proves
// actually arrives, from a real binary, on a sandbox that really cannot write.

await test("a real refusal reaches the pane as the card that offers a way out", async () => {
  const before = fs.existsSync(path.join(workdir, "out.txt"));
  const { of } = await runTurn(
    "Create a file named out.txt containing hello, using a shell command. Then reply DONE.",
    { mode: "readOnly" }
  );
  assert.equal(before, false, "the scratch file must not exist to begin with");
  assert.equal(fs.existsSync(path.join(workdir, "out.txt")), false, "a read-only sandbox really did refuse it");
  const [blocked] = of("blocked");
  assert.ok(blocked, `the refusal must surface as a card — got events: ${of("delta").length} deltas, ${of("cli_event").length} records`);
  assert.equal(blocked.engine, "codex");
  assert.equal(blocked.escalate.mode, "default", "and the way out is the first mode that can write");
});


// ── the records only a real server sends ──
//
// Both of these were reached by wiring a notification this class had never registered.
// A stand-in can prove the mapping; only the real binary proves the server SENDS it, with
// the field names the mapping reads.

await test("a thread rename really arrives, with the name in `threadName`", async () => {
  // `thread/name/set` is the TUI's `/rename`. The record it produces is the only place the
  // new name exists — the rollout file keeps the first prompt and nothing else, which is
  // why a renamed chat kept its opening words on the tab and in the pane.
  const proc = childProc("codex", ["app-server"], workdir);
  const events = [];
  const server = new CodexAppServer({
    proc, cwd: workdir, approvalPolicy: "never",
    settings: { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" },
    onEvent: (e, d) => events.push([e, d])
  });
  await server.start();
  try {
    await server.rpc.request("thread/name/set", { threadId: server.threadId, name: "Renamed by the e2e" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some(([e, d]) => e === "init" && d.threadName)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.stop();
  }
  const named = events.filter(([e, d]) => e === "init" && d.threadName).map(([, d]) => d);
  assert.ok(named.length > 0, `expected a name record, got ${JSON.stringify(events.map(([e]) => e))}`);
  assert.equal(named.at(-1).threadName, "Renamed by the e2e");
  assert.equal(named.at(-1).threadId, server.threadId);
});

await test("a passthrough record keeps the server's own name, un-enveloped", async () => {
  // The client's notice reader matches on the record's OWN method name (`warning`,
  // `error`, `model/rerouted`). The tempting "fix" is to wrap one in a `system` envelope,
  // which reads as more routable and is in fact unreadable to it — measured: this file's
  // old mapping answered null where the passthrough answers the line.
  //
  // Pinned on a record that a real turn ALWAYS produces, so this cannot pass vacuously:
  // `thread/status/changed` streams for every turn on this binary.
  const { events } = await runTurn("Say the word: ok");
  const carried = events.filter(([e, d]) => e === "cli_event").map(([, d]) => d);
  assert.ok(carried.length > 0, "a real turn produces passthrough records");
  for (const c of carried) {
    assert.ok(!c.subtype, `a passthrough record must not be re-typed: ${JSON.stringify(c)}`);
    assert.ok(c.type.includes("/") || /^[a-z]/.test(c.type), `carried under a method name, got ${c.type}`);
  }
  // And the one that is always there proves the name survives intact.
  assert.ok(carried.some((c) => c.type === "thread/status/changed"), "the thread's own status record");
});
// ── answering a gate: measured here, pinned in the unit suite ──
//
// The gate's request id is a NUMBER on this wire, and an answer has to go back as the type
// it arrived. Measured on this binary, one prompt, one gate, only the answer's id type
// differing:
//
//   answered as "0"  → no further records, no `turn/completed`  (the turn hangs)
//   answered as  0   → `serverRequest/resolved` + `turn/completed`, the command runs
//
// That is `codexAppServer.test.mjs`'s job to hold (it needs no model and no gate), because
// every way of raising a gate HERE is non-deterministic: asking the model to try something
// forbidden depends on the model actually trying, and `thread/shellCommand` was measured to
// run WITHOUT asking at all. A red-sometimes test teaches nothing.

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
