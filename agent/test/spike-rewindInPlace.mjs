// Spike: can 9Remote rewind a Claude conversation by TRUNCATING its transcript, keeping
// the same session id — instead of forking into a new one?
//
// Why this is worth real CLI runs rather than reading docs:
//
// 9Remote implements "edit a prompt and rewind" with `--fork-session`, which mints a NEW
// session id and therefore writes a SECOND `.jsonl`. The original is never deleted, and
// the history list enumerates every `.jsonl` for the working directory — so one rewind
// shows up as two conversations. Claude Code's own `/rewind` does not do that: it moves
// the leaf pointer inside the SAME file (anthropics/claude-code#55347).
//
// The candidate fix needs no new CLI flag: rewrite the transcript ourselves, keeping only
// the records up to the target turn, and leave the session id alone. That is exactly what
// `stripForkPrompt` already does to a fork (atomic tmp + rename), pointed at the original
// instead. What is NOT known — and what this measures — is whether the CLI accepts such a
// file on resume: whether the loader picks the truncated leaf, whether the session still
// resolves under its old id, and whether the CLI then appends to that same file.
//
// Measured on a throwaway conversation in a temp directory:
//   1. baseline — the resumed context really does hold all three codewords
//   2. truncate by hand at BRAVO, resume SAME id, NO fork:
//        does it load? does it keep exactly ALPHA+BRAVO and drop CHARLIE?
//        is the session id unchanged? is there still ONE file for this cwd?
//        does the CLI continue appending to it afterwards?
//   3. the forked path, for contrast: how many files this cwd ends up with
//
// Run: node agent/test/spike-rewindInPlace.mjs
//
// Costs a handful of real CLI runs (each one an API request) and removes every artifact
// it creates — transcripts, project dir and temp cwd — in the finally below.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-rewind-spike-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const RUN_TIMEOUT_MS = 120000;

// Find the transcript by id rather than by encoding the cwd: on macOS the CLI resolves
// /var → /private/var when it derives the project directory name, so a hand-built name
// misses (the product scans for the same reason — see claudeTranscript.findTranscript).
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
const jsonlIn = (sid) => { const d = projectDir(sid); if (!d) return []; try { return fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")); } catch { return []; } };

/** One `claude -p` run. Returns the parsed JSON result, or the failure. */
function run(prompt, args = []) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "json", ...args], { cwd: CWD });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: "timed out" }); }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().slice(0, 300) });
      try { const p = JSON.parse(out); resolve({ ok: true, result: p.result || "", sessionId: p.session_id }); }
      catch { resolve({ ok: false, error: `unparseable output: ${out.slice(0, 200)}` }); }
    });
  });
}

/** Every user turn the CLI recorded, in file order — the file's own view of the thread. */
function userTurns(file) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user" || d.isSidechain || !d.uuid) continue;
    const content = d.message?.content;
    // A tool result is stored as a user record too; it is not a turn the user typed.
    const text = typeof content === "string" ? content : (content || []).find((b) => b?.type === "text")?.text || "";
    if (!text) continue;
    out.push({ uuid: d.uuid, text: text.slice(0, 60) });
  }
  return out;
}

const readLines = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; } };
const lineCount = (file) => readLines(file).length;
const say = (label, value) => console.log(`  ${label.padEnd(36)} ${value}`);

/**
 * The candidate fix, in miniature: keep the file's records up to and including the
 * target turn, drop the rest, write atomically, and never touch the session id.
 * Records after the cut that belong to an abandoned branch go too — that is what
 * "rewind" means to the person who asked for it.
 */
function truncateAt(file, targetUuid) {
  const lines = readLines(file);
  const cut = lines.findIndex((l) => {
    try { return JSON.parse(l).uuid === targetUuid; } catch { return false; }
  });
  if (cut === -1) return { ok: false, error: "target turn not found in the transcript" };
  const kept = lines.slice(0, cut + 1);
  const tmp = `${file}.spike`;
  fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
  fs.renameSync(tmp, file);
  return { ok: true, dropped: lines.length - kept.length };
}

console.log("Running rewind-in-place spike...");
console.log(`cwd: ${CWD}\n`);

const created = [];
const seen = (w, res) => (res?.result?.includes(w) ? "yes" : "no");
try {
  // ── A three-turn conversation, each turn carrying a checkable codeword ──
  const first = await run("Remember the codeword ALPHA. Reply with just: OK");
  if (!first.ok) throw new Error(`could not start a session: ${first.error}`);
  const S = first.sessionId;
  created.push(S);
  console.log(`session ${S}\n`);

  const second = await run("Remember the codeword BRAVO. Reply with just: OK", ["--resume", S]);
  const third = await run("Remember the codeword CHARLIE. Reply with just: OK", ["--resume", S]);
  if (!second.ok || !third.ok) throw new Error(`could not extend the session: ${second.error || third.error}`);

  const file = transcript(S);
  const turns = userTurns(file);
  console.log("Recorded turns:");
  for (const [i, t] of turns.entries()) console.log(`  [${i}] ${t.uuid}  ${JSON.stringify(t.text)}`);
  const bravo = turns.find((t) => t.text.includes("BRAVO"));
  if (!bravo) throw new Error("the transcript did not record BRAVO");
  const beforeLines = lineCount(file);
  say("lines before truncation", beforeLines);
  say("files for this cwd", jsonlIn(S).length);

  // ── Baseline: the resumed context really does hold all three ──
  console.log("\n1. Baseline (no rewind)");
  const base = await run("List every codeword you have been told so far, comma separated, nothing else.", ["--resume", S]);
  say("answer", JSON.stringify(base.result));
  say("has ALPHA / BRAVO / CHARLIE", `${seen("ALPHA", base)} / ${seen("BRAVO", base)} / ${seen("CHARLIE", base)}`);
  say("session id unchanged", base.sessionId === S ? "yes" : `NO — ${base.sessionId}`);

  // ── The candidate: hand-truncate, same id, no fork ──
  console.log("\n2. Truncate the transcript at BRAVO, resume the SAME id, no fork");
  const cut = truncateAt(file, bravo.uuid);
  if (!cut.ok) throw new Error(cut.error);
  say("records dropped", cut.dropped);
  say("lines after truncation", lineCount(file));
  say("files for this cwd", `${jsonlIn(S).length} (a fork would make this 2)`);

  const after = await run("List every codeword you have been told so far, comma separated, nothing else.", ["--resume", S]);
  if (!after.ok) {
    say("RESUME FAILED", after.error);
    console.log("\n  → the CLI does not accept a hand-truncated transcript; the fork stays the only option.");
  } else {
    say("answer", JSON.stringify(after.result));
    say("kept ALPHA?", seen("ALPHA", after));
    say("kept BRAVO? (the cut turn)", seen("BRAVO", after));
    say("dropped CHARLIE?", seen("CHARLIE", after) === "no" ? "yes" : "NO — still in context");
    say("session id unchanged", after.sessionId === S ? "yes" : `no — ${after.sessionId}`);
    say("files for this cwd", jsonlIn(S).length);
    // Growth proves the CLI accepted the file and kept writing to it — the whole point.
    say("CLI appended to the same file?", lineCount(file) > 0 ? `${lineCount(file)} lines now` : "file gone");
  }

  // ── Contrast: what the fork does to the file count ──
  console.log("\n3. Fork instead (what 9Remote does today)");
  const forkId = crypto.randomUUID();
  const forked = await run("Reply with just: OK", ["--resume", S, "--fork-session", "--session-id", forkId]);
  if (!forked.ok) {
    say("run failed", forked.error);
  } else {
    created.push(forkId);
    say("new session id", forked.sessionId === S ? `same (${S})` : `${forked.sessionId}`);
    say("files for this cwd", jsonlIn(S).length);
    say("original still on disk", fs.existsSync(file) ? "yes" : "no");
    console.log("\n  → one rewind, two transcripts: this is the reported bug.");
  }
} finally {
  // Leave nothing behind: every transcript this spike made, its project dir, and the cwd.
  const dir = projectDir(created[0]);
  for (const sid of created) { const f = transcript(sid); if (f) { try { fs.unlinkSync(f); } catch {} } }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log("\n(temp sessions, transcripts, project dir and cwd removed)");
}
