// Probe: does an idle Claude CLI write to its transcript when it is stopped, and does
// the CLI still resume correctly from a transcript cut by hand that drops `last-prompt`
// records pointing past the cut?
//
// Two things the rewind rewrite depends on, neither of which the earlier spike covered:
//
//   1. `stopProc` sends SIGINT and returns immediately (ptyDaemon.js:349) — it does NOT
//      wait for the process to die. The comment says the signal exists so "a CLI
//      interrupting its own turn is how it gets to flush the transcript". If an IDLE CLI
//      also flushes on SIGINT, then stopping → cutting → restarting still races: the old
//      process can write the pre-cut conversation back over the cut.
//   2. `cutAt` slices by line index, so `last-prompt` records (which carry `leafUuid`,
//      the pointer the CLI's resume uses to find the newest leaf) are cut too. The file
//      must still resume to the right branch afterwards.
//
// Run: node agent/test/spike-rewindRace.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-race-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const RUN_TIMEOUT_MS = 120000;

function transcript(sid) {
  if (!sid) return null;
  let entries;
  try { entries = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(PROJECTS, entry, `${sid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const projectDir = (sid) => { const f = transcript(sid); return f ? path.dirname(f) : null; };
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; } };
const say = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);

/** One short `claude -p` run. */
function runOnce(prompt, args = []) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "json", ...args], { cwd: CWD });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: "timed out" }); }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().slice(0, 200) });
      try { const p = JSON.parse(out); resolve({ ok: true, result: p.result || "", sessionId: p.session_id }); }
      catch { resolve({ ok: false, error: "unparseable" }); }
    });
  });
}

/** A long-lived interactive CLI, the way the daemon holds one: stream-json on stdin. */
function spawnInteractive(sessionId) {
  const child = spawn("claude", [
    "-p", "--verbose", "--input-format=stream-json", "--output-format=stream-json",
    "--permission-mode", "default", "--allow-dangerously-skip-permissions",
    "--resume", sessionId
  ], { cwd: CWD });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

const userTurns = (f) => readLines(f).flatMap((l) => {
  try {
    const d = JSON.parse(l);
    if (d.type !== "user" || d.isSidechain || !d.uuid) return [];
    const c = d.message?.content;
    const text = typeof c === "string" ? c : (c || []).find((b) => b?.type === "text")?.text || "";
    return text ? [{ uuid: d.uuid, text: text.slice(0, 40) }] : [];
  } catch { return []; }
});

console.log("Running rewind race probe...\n");
const created = [];
try {
  const first = await runOnce("Say the word ALPHA and nothing else.");
  if (!first.ok) throw new Error(first.error);
  const S = first.sessionId;
  created.push(S);
  await runOnce("Say the word BRAVO and nothing else.", ["--resume", S]);
  const file = transcript(S);
  console.log(`session ${S}\n`);

  // ── 1. Does an IDLE process rewrite the transcript when it is SIGINT'd? ──
  console.log("1. SIGINT an idle interactive CLI (what stopProc does)");
  const child = spawnInteractive(S);
  await new Promise((r) => setTimeout(r, 6000)); // let it boot and settle
  const beforeStop = readLines(file);
  say("lines before SIGINT", beforeStop.length);
  child.kill("SIGINT");
  // The daemon returns immediately; this mirrors that, then watches the file.
  await new Promise((r) => setTimeout(r, 300));
  const rightAfter = readLines(file).length;
  say("lines 300ms after SIGINT", rightAfter);
  await new Promise((r) => setTimeout(r, 3500)); // past PROC_KILL_GRACE_MS
  const settled = readLines(file).length;
  say("lines after the kill grace", settled);
  say("did a stopped process write?", settled !== beforeStop.length ? "YES — a race exists" : "no");

  // ── 2. Cut past the leaf pointers, then resume ──
  console.log("\n2. Cut the transcript so `last-prompt` leaf pointers fall outside it");
  const turns = userTurns(file);
  for (const [i, t] of turns.entries()) console.log(`   [${i}] ${t.uuid} ${JSON.stringify(t.text)}`);
  const alpha = turns.find((t) => t.text.includes("ALPHA"));
  const leafRecords = readLines(file).filter((l) => l.includes("leafUuid")).length;
  say("records carrying leafUuid", leafRecords);

  const lines = readLines(file);
  const cut = lines.findIndex((l) => { try { return JSON.parse(l).uuid === alpha.uuid; } catch { return false; } });
  say("cut index", `${cut} of ${lines.length}`);
  fs.writeFileSync(file, `${lines.slice(0, cut + 1).join("\n")}\n`);
  say("lines after the cut", readLines(file).length);

  const resumed = await runOnce("List every word you were told to say, comma separated, nothing else.", ["--resume", S]);
  if (!resumed.ok) {
    say("RESUME FAILED", resumed.error);
  } else {
    say("answer", JSON.stringify(resumed.result));
    say("kept ALPHA?", resumed.result.includes("ALPHA") ? "yes" : "no");
    say("dropped BRAVO?", resumed.result.includes("BRAVO") ? "NO — still in context" : "yes");
    say("files for this cwd", fs.readdirSync(projectDir(S)).filter((f) => f.endsWith(".jsonl")).length);
  }
} finally {
  const dir = projectDir(created[0]);
  for (const sid of created) { const f = transcript(sid); if (f) { try { fs.unlinkSync(f); } catch {} } }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log("\n(temp sessions, transcripts, project dir and cwd removed)");
}
