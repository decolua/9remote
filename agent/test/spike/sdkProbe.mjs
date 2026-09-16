// P0 probes: four questions that decide the sdkBridge/adapter shape. Throwaway.
// Run: node agent/test/spike/sdkProbe.mjs [1|2|3|4|all]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const log = (...a) => console.log(...a);
const line = (s) => log(`\n${"─".repeat(70)}\n${s}\n${"─".repeat(70)}`);

// Spawn the CLI exactly as claudeAdapter does, so the probe answers for OUR entrypoint.
function spawnCli(args, { cwd = process.cwd(), env = {} } = {}) {
  const child = spawn("claude", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const rl = readline.createInterface({ input: child.stdout });
  const records = [];
  rl.on("line", (l) => { try { records.push(JSON.parse(l)); } catch { records.push({ _raw: l }); } });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  return { child, records, stderr: () => stderr };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Probe 1: does a LIVE CLI answer a second `initialize` mid-turn? ──────────────
async function probe1() {
  line("PROBE 1 — second `initialize` on a live process mid-turn");
  const { child, records, stderr } = spawnCli([
    "-p", "--verbose",
    "--input-format=stream-json", "--output-format=stream-json",
    "--include-partial-messages", "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
  ]);
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

  // Kick off a turn that will still be running when we send the second initialize.
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: "Count from 1 to 40, one number per line." }] } });
  // Mid-turn means the turn has NOT ended: the last record the CLI wrote is not a
  // `result`. "A stream_event exists somewhere" is not the same claim and was wrong
  // here — it stayed true long after the turn closed.
  const stillRunning = () => {
    const last = records[records.length - 1];
    if (!last) return false;
    return last.type !== "result";
  };
  let midTurn = false;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    if (records.some((r) => r.type === "result")) break;
    if (stillRunning() && records.some((r) => r.type === "stream_event")) { midTurn = true; break; }
  }
  log(`  turn still open before initialize#2: ${midTurn} (last=${records[records.length - 1]?.type})`);
  if (!midTurn) log("  WARNING: turn was not in flight — verdict is inconclusive");
  const before = records.length;
  const lastBefore = records[records.length - 1];
  send({ type: "control_request", request_id: "probe-init-2", request: { subtype: "initialize" } });
  // Watch the whole window: a turn that keeps going ends with its own `result`.
  let ended = false;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    if (records.slice(before).some((r) => r.type === "result")) { ended = true; break; }
  }

  const after = records.slice(before);
  const resp = after.find((r) => r.type === "control_response" && r.response?.request_id === "probe-init-2");
  const turnContinued = ended;
  log(`  initialize#2 answered: ${resp ? "YES" : "NO"}`);
  if (resp) {
    const keys = Object.keys(resp.response?.response || {});
    log(`  response keys: ${keys.join(", ") || "(none)"}`);
    log(`  commands: ${resp.response.response?.commands?.length ?? "-"}  pending_permission: ${resp.response.pending_permission_requests?.length ?? "-"}  pending_dialog: ${resp.response.pending_user_dialog_requests?.length ?? "-"}`);
  }
  log(`  turn continued after initialize#2: ${turnContinued}`);
  log(`  VERDICT: ${resp && turnContinued ? "bridge is viable" : "bridge BREAKS the turn or is unanswered"}`);
  child.kill("SIGKILL");
}

// ── Probe 4: which callback carries AskUserQuestion — canUseTool or user dialog? ──
async function probe4() {
  line("PROBE 4 — what does the CLI send for AskUserQuestion?");
  const { child, records } = spawnCli([
    "-p", "--verbose",
    "--input-format=stream-json", "--output-format=stream-json",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", "default",
    "--allow-dangerously-skip-permissions",
  ]);
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: "Use the AskUserQuestion tool right now to ask me which color I prefer. Do not answer in text - call the tool." }] } });

  const sawResult = () => records.some((r) => r.type === "result");
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    if (sawResult()) break;
  }

  const texts = records.filter((r) => r.type === "assistant")
    .flatMap((r) => r.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  log(`  assistant said: ${JSON.stringify(texts.slice(0, 200))}`);

  const reqs = records.filter((r) => r.type === "control_request");
  log(`  control_requests seen: ${reqs.length}`);
  for (const r of reqs) {
    log(`    subtype=${r.request?.subtype} tool_name=${r.request?.tool_name ?? "-"} keys=${Object.keys(r.request || {}).join(",")}`);
    if (r.request?.subtype === "request_user_dialog") log(`    dialog_kind=${r.request?.dialog_kind} payload=${JSON.stringify(r.request?.payload || {}).slice(0, 300)}`);
  }

  const askedAsDialog = reqs.some((r) => r.request?.subtype === "request_user_dialog");
  const askedAsTool = reqs.some((r) => r.request?.tool_name === "AskUserQuestion");
  const anyGate = reqs.some((r) => r.request?.subtype === "can_use_tool");
  log(`  gates: can_use_tool=${anyGate} ask_as_tool=${askedAsTool} ask_as_dialog=${askedAsDialog}`);
  log(`  VERDICT: ${askedAsDialog ? "onUserDialog (dialog_kind)" : askedAsTool ? "canUseTool (as a tool)" : "NOT OBSERVED — model may not have called the tool"}`);
  child.kill("SIGKILL");
}

// ── Probe 3: does the SDK accept an external CLI, and which version? ─────────────
async function probe3() {
  line("PROBE 3 — SDK with pathToClaudeCodeExecutable (external CLI)");
  let sdk;
  try {
    sdk = await import("/Users/Working/9remote/.source/chat-poc/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
  } catch (e) {
    log(`  SDK not importable from chat-poc: ${e.message}`);
    log(`  VERDICT: inconclusive — install the dep into agent/ first`);
    return;
  }
  const which = spawn("which", ["claude"]);
  let claudePath = "";
  which.stdout.on("data", (d) => { claudePath += d.toString().trim(); });
  await new Promise((r) => which.on("close", r));
  log(`  external claude: ${claudePath}`);

  try {
    const q = sdk.query({
      prompt: "Reply with exactly: OK",
      options: {
        pathToClaudeCodeExecutable: claudePath,
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        stderr: (d) => { if (d.trim()) log(`  [stderr] ${d.trim().slice(0, 200)}`); },
      },
    });
    let sawInit = false, sawResult = false, resultText = "";
    const t = setTimeout(() => q.close(), 60000);
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") { sawInit = true; log(`  init: model=${msg.model} tools=${msg.tools?.length}`); }
      if (msg.type === "assistant") { const c = msg.message?.content || []; resultText += c.filter((x) => x.type === "text").map((x) => x.text).join(""); }
      if (msg.type === "result") { sawResult = true; log(`  subtype=${msg.subtype} is_error=${msg.is_error} result=${JSON.stringify(String(msg.result || "").slice(0, 120))}`); }
    }
    clearTimeout(t);
    log(`  VERDICT: ${sawInit && sawResult ? "external CLI works with SDK" : "NO init/result — version mismatch"}`);
  } catch (e) {
    log(`  ERROR: ${e.message}`);
    log(`  VERDICT: external CLI REJECTED`);
  }
}

// ── Probe 2: does resumeSessionAt shorten the transcript file? ───────────────────
// Uses the REAL config dir (a fresh one would break auth) but a throwaway cwd, so the
// only transcript touched is this probe's own conversation.
async function probe2() {
  line("PROBE 2 — does resumeSessionAt shorten the .jsonl, or only the loaded context?");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe2-"));

  const run = (prompt, extra = []) => new Promise((resolve) => {
    const { child, records } = spawnCli([
      "-p", "--verbose", "--input-format=stream-json", "--output-format=stream-json",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
      ...extra,
    ], { cwd: tmp });
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n");
    child.on("close", () => {
      const init = records.find((r) => r.type === "system" && r.subtype === "init");
      resolve({ sessionId: init?.session_id, records });
    });
    setTimeout(() => child.kill("SIGKILL"), 90000);
  });

  const a = await run("Say exactly: one");
  const b = await run("Say exactly: two", ["--resume", a.sessionId]);
  log(`  session: ${a.sessionId}  (second turn opened ${b.sessionId})`);

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const safe = tmp.replace(/[/\\:]/g, "-");
  let file = path.join(projectsRoot, safe, `${a.sessionId}.jsonl`);
  if (!fs.existsSync(file)) {
    for (const e of fs.readdirSync(projectsRoot)) {
      const c = path.join(projectsRoot, e, `${a.sessionId}.jsonl`);
      if (fs.existsSync(c)) { file = c; break; }
    }
  }
  if (!fs.existsSync(file)) { log("  VERDICT: transcript not found — inconclusive"); return; }

  const read = () => fs.readFileSync(file, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const before = read();
  log(`  transcript lines before cut: ${before.length}`);

  const prompts = before.filter((r) => r.type === "user" && r.uuid && !r.isMeta && !r.isSidechain);
  log(`  user turns: ${prompts.map((r) => r.uuid).join(", ")}`);
  if (prompts.length < 2) { log("  VERDICT: fewer than 2 user turns — inconclusive"); return; }
  const cutTo = prompts[0].uuid;

  // The pair the SDK would send: resume at the KEPT turn, declare the dropped turn.
  const dropped = prompts[1].uuid;
  const c = await run("Say exactly: three", [
    "--resume", a.sessionId,
    "--resume-session-at", cutTo,
    "--resume-drops-turn", dropped,
  ]);
  const refused = c.records.find((r) => r.type === "result" && String(r.result || "").startsWith("Resume rejected"));
  log(`  third run subtype: ${c.records.find((r) => r.type === "result")?.subtype ?? "-"}${refused ? "  (REFUSED)" : ""}`);

  const after = read();
  log(`  transcript lines after: ${after.length}`);
  const stillHasDropped = after.some((r) => r.uuid === dropped);
  log(`  dropped turn still in file: ${stillHasDropped}`);
  log(`  VERDICT: ${after.length < before.length ? "FILE SHORTENED — resumeSessionAt can replace cutAt()" : "FILE UNCHANGED — must KEEP cutAt()"}`);
  log(`  (cwd: ${tmp})`);
}

const which = process.argv[2] || "all";
if (which === "all" || which === "3") await probe3();
if (which === "all" || which === "1") await probe1();
if (which === "all" || which === "4") await probe4();
if (which === "all" || which === "2") await probe2();
log("\ndone.");
