// Spike: can Claude's rewind be driven over the CLI's OWN control protocol instead of
// rewriting its transcript by hand?
//
// Why this is worth real CLI runs rather than reading docs:
//
// 9Remote implements "edit a prompt and rewind" by reading `~/.claude/projects/*.jsonl`,
// slicing it and writing it back (claudeRewind.cutAt), then racing the still-running CLI
// process that holds the discarded turns in memory — see spike-rewindRace.mjs, which
// exists only to measure that race. All of that exists because the CLI's rewind looked
// like flags-only: `--rewind-files` for files, nothing for the conversation.
//
// Strings taken from the installed binary (2.1.273) say otherwise. Two control requests
// are implemented and reachable over the stream-json pipe 9Remote already holds open:
//
//   rewind_files        { user_message_id, dry_run }   — same thing as --rewind-files
//   rewind_conversation { target_message_uuid, interrupt_if_running,
//                         last_seen_user_message_uuid } — the CLI cuts its OWN
//                         conversation, in memory, under the same session id
//
// Neither has a published schema and neither is in `claude --help`. What this measures:
//
//   1. does the CLI answer `rewind_files` at all over this pipe, and what does the
//      response carry (schema, and whether `dry_run` is a real preview)?
//   2. does it answer `rewind_conversation`? Which uuid means what — is the target the
//      turn that SURVIVES or the first turn that goes?
//   3. does the conversation cut actually cut (a later prompt cannot recall the dropped
//      turn), and does the session id survive?
//   4. does rewind_conversation ALSO restore files, or is that a second request?
//   5. does the transcript stay one file (the fork bug that started all this)?
//
// Run: node agent/test/spike-controlRewind.mjs
//
// Costs a few real CLI runs and removes every artifact it creates — transcripts, project
// dir and temp cwd — in the finally below.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-ctl-rewind-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const TURN_TIMEOUT_MS = 180000;
const NOTE = path.join(CWD, "note.txt");

const readNote = () => { try { return fs.readFileSync(NOTE, "utf8").trim(); } catch { return "(missing)"; } };
const say = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

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
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; } };

/** User turns the CLI recorded, in file order, with the text the user typed. */
const userTurns = (f) => readLines(f).flatMap((l) => {
  try {
    const d = JSON.parse(l);
    if (d.type !== "user" || d.isSidechain || !d.uuid) return [];
    const c = d.message?.content;
    const text = typeof c === "string" ? c : (c || []).find((b) => b?.type === "text")?.text || "";
    return text ? [{ uuid: d.uuid, text }] : [];
  } catch { return []; }
});

/**
 * One long-lived CLI, held the way the daemon holds one: stream-json in, stream-json out.
 * Checkpointing is on because the SDK entrypoint does not turn it on by itself — the same
 * env the product sets (see adapters/env.js).
 */
function spawnCli(resumeId) {
  const child = spawn("claude", [
    "-p", "--verbose",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
    "--input-format=stream-json", "--output-format=stream-json",
    ...(resumeId ? ["--resume", resumeId] : [])
  ], {
    cwd: CWD,
    env: { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" }
  });
  child.stdin.on("error", () => {});
  return child;
}

let child = spawnCli();
const pending = new Map();   // request_id → resolve
let nextId = 1;
let onResult = null;

const write = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch {} };

/** Send a turn and wait for its `result` record. */
function prompt(text) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "turn timed out" }), TURN_TIMEOUT_MS);
    onResult = (record) => { clearTimeout(timer); resolve({ ok: true, result: record }); };
    write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  });
}

/** A control request, resolved with the CLI's own answer object. */
function control(request) {
  return new Promise((resolve) => {
    const request_id = String(nextId++);
    const timer = setTimeout(() => { pending.delete(request_id); resolve({ ok: false, error: "no answer in 30s" }); }, 30000);
    pending.set(request_id, (msg) => { clearTimeout(timer); resolve(msg); });
    write({ type: "control_request", request_id, request });
  });
}

/** Read one CLI's lines. Re-attached on every respawn — see phase 6. */
function listen() {
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_response") {
      const r = msg.response || {};
      const fn = pending.get(r.request_id);
      if (fn) { pending.delete(r.request_id); fn(r.error ? { ok: false, error: r.error } : { ok: true, response: r.response }); }
      return;
    }
    if (msg.type === "result" && onResult) { const fn = onResult; onResult = null; fn(msg); }
  });
}
listen();

console.log("Running control-protocol rewind spike...");
console.log(`cwd: ${CWD}\n`);

let SESSION = null;
try {
  // ── Two turns, each writing a checkable word into the same file ──
  console.log("0. Two turns that each write note.txt");
  // Through the Write tool, not a shell redirect: the CLI only checkpoints file
  // changes it makes itself, so `echo > note.txt` would leave nothing to restore and
  // the file half of this spike would measure the wrong thing.
  const t1 = await prompt("Use the Write tool to create ./note.txt containing exactly: ALPHA. Then reply with just: DONE");
  if (!t1.ok) throw new Error(t1.error);
  const t2 = await prompt("Use the Write tool to overwrite ./note.txt with exactly: BRAVO. Then reply with just: DONE");
  if (!t2.ok) throw new Error(t2.error);
  SESSION = t1.result.session_id;
  say("session", SESSION);
  say("note.txt on disk", readNote());

  const file = transcript(SESSION);
  const turns = userTurns(file);
  for (const [i, t] of turns.entries()) console.log(`     [${i}] ${t.uuid}  ${JSON.stringify(t.text.slice(0, 44))}`);
  const alpha = turns.find((t) => t.text.includes("ALPHA"));
  const bravo = turns.find((t) => t.text.includes("BRAVO"));
  if (!alpha || !bravo) throw new Error("the transcript did not record both turns");

  // ── 1. rewind_files, as a dry run first: it should be the preview the UI needs ──
  console.log("\n1. control_request: rewind_files (dry_run)");
  const dry = await control({ subtype: "rewind_files", user_message_id: alpha.uuid, dry_run: true });
  console.log(`  → ${JSON.stringify(dry)}`);
  say("note.txt unchanged", readNote());

  // ── 2. rewind_conversation: which uuid is the target, and is the session kept? ──
  console.log("\n2. control_request: rewind_conversation (target = the BRAVO turn)");
  const cut = await control({ subtype: "rewind_conversation", target_message_uuid: bravo.uuid, interrupt_if_running: true });
  console.log(`  → ${JSON.stringify(cut)}`);
  say("note.txt after the cut", readNote());
  say("files for this cwd", `${jsonlIn(SESSION).length} (a fork would make this 2)`);
  say("lines in transcript", readLines(file).length);

  // ── 3. Did the CONVERSATION actually cut? Ask the model what it was told ──
  console.log("\n3. Ask the cut conversation what words it was told to write");
  const back = await prompt("List every word you were ever told to write into note.txt, comma separated, nothing else.");
  if (!back.ok) {
    say("TURN FAILED", back.error);
  } else {
    const answer = back.result.result || "";
    say("answer", JSON.stringify(answer));
    say("still remembers BRAVO?", answer.includes("BRAVO") ? "YES — the cut did not take" : "no");
    say("session id unchanged", back.result.session_id === SESSION ? "yes" : `NO — ${back.result.session_id}`);
    say("files for this cwd", jsonlIn(SESSION).length);
  }

  // ── 4. The file half is its own request; the cut above left note.txt alone ──
  console.log("\n4. control_request: rewind_files (real) — restore note.txt to the ALPHA turn");
  const real = await control({ subtype: "rewind_files", user_message_id: alpha.uuid, dry_run: false });
  console.log(`  → ${JSON.stringify(real)}`);
  say("note.txt afterwards", readNote());

  // ── 5. Every chat 9Remote reopens goes through `--resume`. Does the pipe still cut? ──
  // `last_seen_user_message_uuid` is the anchor the CLI compares its own leaf against —
  // a stale one may be exactly why phase 6 refuses, so the CURRENT leaf is measured here
  // rather than guessed.
  console.log("\n5. Respawn with --resume, then cut from that process");
  const beforeResume = userTurns(transcript(SESSION));
  const leaf = beforeResume[beforeResume.length - 1];
  say("current leaf", `${leaf?.uuid} ${JSON.stringify(leaf?.text.slice(0, 30))}`);
  try { child.kill("SIGKILL"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  child = spawnCli(SESSION);
  listen();
  const resumed = await prompt("Reply with just: READY");
  say("resume accepted", resumed.ok ? "yes" : resumed.error);
  if (resumed.ok) {
    // The anchor must be the NEWEST turn the caller has seen — the CLI refuses when it
    // knows of a later one ("unseen later turn", phase 5 of the previous run), so it is
    // re-read here rather than reused from before the respawn.
    const now = userTurns(transcript(SESSION));
    const anchor = now[now.length - 1];
    say("anchor", `${anchor?.uuid} ${JSON.stringify(anchor?.text.slice(0, 30))}`);
    // Target the FIRST recorded turn — the edge cutAt calls "keep nothing".
    const first = await control({
      subtype: "rewind_conversation",
      target_message_uuid: alpha.uuid,
      interrupt_if_running: true,
      last_seen_user_message_uuid: anchor?.uuid
    });
    console.log(`  → ${JSON.stringify(first)}`);
    say("lines in transcript", readLines(file).length);
    const after = await prompt("List every word you were ever told to write into note.txt, comma separated, nothing else.");
    if (!after.ok) {
      say("TURN FAILED", after.error);
    } else {
      const answer = after.result.result || "";
      say("answer", JSON.stringify(answer));
      say("kept ALPHA?", answer.includes("ALPHA") ? "yes" : "no");
      say("session id unchanged", after.result.session_id === SESSION ? "yes" : `NO — ${after.result.session_id}`);
      say("files for this cwd", jsonlIn(SESSION).length);
    }
  }

  console.log("\n  → both halves answered over the pipe 9Remote already holds: no transcript");
  console.log("    rewrite, no stop/start of the running CLI, no race to lose.");
} catch (e) {
  console.log(`\n  FAILED: ${e.message}`);
} finally {
  try { child.kill("SIGKILL"); } catch {}
  const dir = projectDir(SESSION);
  const f = transcript(SESSION);
  if (f) { try { fs.unlinkSync(f); } catch {} }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log("\n(temp session, transcript, project dir and cwd removed)");
  process.exit(0);
}
