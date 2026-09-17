// Spike: the SHIPPED path, end to end — ClaudeAdapter + JsonRpcClient against the real
// CLI, driving `rewindConversation` and `rewindFiles`.
//
// spike-controlRewind.mjs established that the CLI implements both control requests; it
// hand-rolled its own pipe to ask. This one asks through the code the product actually
// runs, so the envelope, the correlation and the adapter's own error shapes are covered
// rather than assumed — a hand-rolled pipe that works says nothing about ours.
//
// What it exercises:
//   1. rewindFiles(uuid, { dryRun: true })  — the preview the modal shows
//   2. rewindConversation(uuid, lastSeen)   — the cut, and the prefillText it returns
//   3. an anchor behind the CLI's leaf is refused, not half-applied
//   4. cut + files with ONE uuid — that the turn which goes is also the turn whose own
//      writes are undone (`claudeApply` applies both halves with `target`)
//   5. the other order, cut-then-files, to show the product's order is a choice about
//      failure, not a requirement of the CLI
//
// Run: node agent/test/spike-adapterRewind.mjs
//
// Costs a few real CLI runs; removes the session, transcript, project dir and cwd after.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-adapter-rewind-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const TURN_TIMEOUT_MS = 180000;
const NOTE = path.join(CWD, "note.txt");

const say = (label, value) => console.log(`  ${label.padEnd(32)} ${value}`);
const readNote = () => { try { return fs.readFileSync(NOTE, "utf8").trim(); } catch { return "(missing)"; } };

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
const userTurns = (f) => {
  let raw = "";
  try { raw = fs.readFileSync(f, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((l) => {
    try {
      const d = JSON.parse(l);
      if (d.type !== "user" || d.isSidechain || !d.uuid) return [];
      const c = d.message?.content;
      const text = typeof c === "string" ? c : (c || []).find((b) => b?.type === "text")?.text || "";
      return text ? [{ uuid: d.uuid, text }] : [];
    } catch { return []; }
  });
};

console.log("Running adapter rewind spike...");
console.log(`cwd: ${CWD}\n`);

let adapter = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
let sessionId = null;

/** One turn through the adapter: send, collect what it said, wait for `result`. */
function prompt(text) {
  return new Promise((resolve) => {
    let said = "";
    const timer = setTimeout(() => resolve({ ok: false, error: "turn timed out" }), TURN_TIMEOUT_MS);
    adapter.onEvent = (event, data) => {
      if (event === "delta") { said += data?.text || ""; return; }
      if (event !== "turn_complete" && event !== "error") return;
      clearTimeout(timer);
      adapter.onEvent = () => {};
      resolve(event === "error" ? { ok: false, error: data?.message } : { ok: true, said });
    };
    adapter.sendPrompt(text);
  });
}

try {
  await adapter.start("bypassPermissions", null);

  console.log("0. Two turns that each write note.txt");
  const t1 = await prompt("Use the Write tool to create ./note.txt containing exactly: ALPHA. Then reply with just: DONE");
  if (!t1.ok) throw new Error(t1.error);
  const t2 = await prompt("Use the Write tool to overwrite ./note.txt with exactly: BRAVO. Then reply with just: DONE");
  if (!t2.ok) throw new Error(t2.error);
  sessionId = adapter.metadata.sessionId;
  say("session", sessionId);
  say("note.txt on disk", readNote());

  const file = transcript(sessionId);
  const turns = userTurns(file);
  for (const [i, t] of turns.entries()) console.log(`     [${i}] ${t.uuid}  ${JSON.stringify(t.text.slice(0, 44))}`);
  const alpha = turns.find((t) => t.text.includes("ALPHA"));
  const bravo = turns.find((t) => t.text.includes("BRAVO"));
  if (!alpha || !bravo) throw new Error("the transcript did not record both turns");

  console.log("\n1. adapter.rewindFiles(alpha, { dryRun: true })");
  console.log(`  → ${JSON.stringify(await adapter.rewindFiles(alpha.uuid, { dryRun: true }))}`);
  say("note.txt unchanged", readNote());

  console.log("\n2. adapter.rewindConversation(bravo, lastSeen=bravo)");
  const cut = await adapter.rewindConversation(bravo.uuid, bravo.uuid);
  console.log(`  → ${JSON.stringify(cut)}`);
  say("rewound", cut.rewound);
  say("prefillText is the cut turn", cut.prefillText?.includes("BRAVO") ? "yes" : JSON.stringify(cut.prefillText?.slice(0, 40)));
  say("files for this cwd", `${jsonlIn(sessionId).length} (a fork would make this 2)`);

  // An anchor behind the CLI's own leaf: it knows of a turn the caller claims not to have
  // seen, so cutting would discard a turn nobody rendered. This is the guard the
  // hand-rolled cut never had, and it has to be produced rather than assumed — the CLI
  // only refuses an anchor it can see is behind.
  console.log("\n3. An anchor behind the CLI's leaf is refused");
  const t3 = await prompt("Reply with just: CHARLIE");
  if (!t3.ok) throw new Error(t3.error);
  say("transcript turns now", userTurns(transcript(sessionId)).length);
  const stale = await adapter.rewindConversation(alpha.uuid, alpha.uuid);
  console.log(`  → ${JSON.stringify(stale)}`);
  say("refused", stale.rewound === false ? `yes (${stale.reason})` : "NO — it cut anyway");
  // Refused as a RESULT, not as a rejection: the caller decides what it means, and an
  // adapter that threw here would make every refusal an exception to be caught twice.
  say("came back as a result", typeof stale === "object" && !stale.error ? "yes" : `rejected: ${stale.error}`);

  // The pane only rebuilds if the transcript is ALREADY shortened when this returns: the
  // product reads it right here (`session.reloadFromStore()`), and a CLI that answers
  // before flushing would leave every client rendering the turns it just discarded.
  console.log("\n3b. Is the transcript shortened by the time the answer arrives?");
  const now = userTurns(transcript(sessionId));
  const beforeCut = now.length;
  const cutNow = await adapter.rewindConversation(now.at(-1).uuid, now.at(-1).uuid);
  const immediately = userTurns(transcript(sessionId)).length;
  say("turns before → after", `${beforeCut} → ${immediately}`);
  say("cut reported", cutNow.rewound);
  // A lag is fixable (wait, or retry); the file simply never being rewritten until the
  // next turn is not — it means the host must not read the transcript for this at all.
  for (const wait of [50, 250, 1000, 3000]) {
    await new Promise((r) => setTimeout(r, wait));
    say(`${wait}ms later`, `${userTurns(transcript(sessionId)).length} turns`);
  }
  say("readable at once", immediately < beforeCut ? "yes — reloadFromStore sees the cut" : "NO — the file lags the answer");
  // If the file never shortens, does it still hold the turn that was cut, and does the
  // product's own rebuild hand it back? That is the difference between "the pane is
  // stale" and "the pane is wrong".
  const raw = fs.readFileSync(transcript(sessionId), "utf8");
  say("cut turn still on disk", raw.includes(cutNow.targetMessageUuid || "?") ? "yes" : "no");
  say("leafUuid records", raw.split("\n").filter((l) => l.includes("leafUuid")).length);
  // The CLI's own `/rewind` moves the leaf POINTER inside the same file rather than
  // truncating it. If that is what this is, the pointer is the cut, and a rebuild that
  // reads every line will always hand back the turns a rewind discarded.
  for (const l of raw.split("\n")) {
    if (!l.includes("leafUuid")) continue;
    try { const d = JSON.parse(l); say(`  ${d.type}`, `leaf=${d.leafUuid} prompt=${JSON.stringify(String(d.lastPrompt || "").slice(0, 20))}`); } catch {}
  }
  const { recoverFromClaudeTranscript } = await import("../features/ai/claudeTranscript.js");
  const replayed = recoverFromClaudeTranscript(CWD, sessionId) || [];
  const prompts = replayed.filter((e) => e.event === "user_message").map((e) => e.data.text.slice(0, 22));
  say("rebuilt turns", `${prompts.length}: ${JSON.stringify(prompts)}`);
  // Does anything ever write the cut down? Two candidates: the next turn (the CLI has to
  // append somewhere) and the process going away. If neither does, no reader of this file
  // can ever see the cut, and the host must not rebuild from it after a rewind.
  await prompt("Reply with just: ECHO");
  say("after one more turn", `${userTurns(transcript(sessionId)).length} turns`);
  const replayed2 = recoverFromClaudeTranscript(CWD, sessionId) || [];
  say("rebuilt prompts now", JSON.stringify(replayed2.filter((e) => e.event === "user_message").map((e) => e.data.text.slice(0, 20))));

  // The file keeps what the CLI dropped, so the cut must be recorded as a POINTER —
  // Claude's transcript is a tree (`parentUuid` per record) whose live branch is named by
  // `leafUuid`. Walk that chain: if it is the conversation `--resume` answers from, then
  // the branch — not the file — is what a rebuild must follow.
  const all = fs.readFileSync(transcript(sessionId), "utf8").split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const leaves = all.filter((r) => r.type === "last-prompt");
  const leaf = leaves.at(-1)?.leafUuid;
  say("last-prompt records", `${leaves.length}, leaf=${leaf || "(none)"}`);
  say("records carry parentUuid", all.some((r) => r.parentUuid !== undefined) ? "yes" : "no");
  const byUuid = new Map(all.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  const chain = [];
  const seen = new Set();
  for (let cur = leaf; cur && byUuid.has(cur) && !seen.has(cur); ) {
    seen.add(cur);
    const rec = byUuid.get(cur);
    const c = rec.message?.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b) => b?.type === "text")?.text || "") : "");
    if (rec.type === "user" && text) chain.unshift(text.slice(0, 20));
    cur = rec.parentUuid;
  }
  say("chain from the leaf", JSON.stringify(chain));
  // Where it stops decides whether the leaf walk is a usable rebuild: a chain that breaks
  // at the first hop means the pointer names something this file does not hold.
  let hops = 0, cur = leaf, stop = "";
  while (cur && hops < 200) {
    const rec = byUuid.get(cur);
    if (!rec) { stop = `no record for ${cur}`; break; }
    hops++;
    cur = rec.parentUuid;
    if (!cur) { stop = "parentUuid was null/undefined"; break; }
  }
  say("hops from leaf", `${hops} — stopped: ${stop}`);
  say("user records in file", all.filter((r) => r.type === "user" && r.uuid).length);
  // The question the fix turns on: is a dropped turn reachable from the leaf? If the walk
  // excludes it, a leaf-aware rebuild is the fix; if not, the file holds no answer.
  const onBranch = (needle) => {
    const hit = all.find((r) => r.type === "user" && JSON.stringify(r.message?.content || "").includes(needle));
    return hit ? seen.has(hit.uuid) : "not in file";
  };
  say("CHARLIE on the leaf branch", onBranch("CHARLIE"));
  say("ECHO on the leaf branch", onBranch("ECHO"));

  // The decisive one: does the cut survive the process? A `--resume` reads the file, so if
  // the CLI answers from the turns it just cut, then no reader of that file can ever see
  // the rewind — and the host rebuilding from it would resurrect them on every F5.
  await adapter.stop();
  say("after the CLI stops", `${userTurns(transcript(sessionId)).length} turns`);
  adapter = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
  await adapter.start("bypassPermissions", sessionId);
  const resumeTurn = await prompt("List every phrase you were ever told to reply with, comma separated, nothing else.");
  if (!resumeTurn.ok) {
    say("RESUME FAILED", resumeTurn.error);
  } else {
    say("after resume", JSON.stringify(resumeTurn.said.slice(0, 100)));
    say("still knows CHARLIE?", resumeTurn.said.includes("CHARLIE") ? "YES — the cut did not survive" : "no — the cut is in the CLI's state");
  }

  // The claim `claudeApply` is built on: the uuid that CUTS the conversation also undoes
  // that turn's own writes. If the file half needed the turn before, applying both with
  // one uuid would silently leave one turn's file behind.
  console.log("\n4. rewind_conversation followed by rewind_files, SAME uuid");
  console.log(`  → ${JSON.stringify(await adapter.rewindConversation(alpha.uuid, userTurns(transcript(sessionId)).at(-1)?.uuid))}`);
  console.log(`  → ${JSON.stringify(await adapter.rewindFiles(alpha.uuid))}`);
  say("note.txt afterwards", readNote());

  // The other order: cut the conversation first, then ask for the files. If this restores
  // just as well, the order in `claudeApply` is a preference rather than a requirement —
  // and if it does not, the product's order is load-bearing and must not be "tidied".
  console.log("\n5. The cut-then-files ORDER, against the same case");
  const SECOND = path.join(CWD, "second.txt");
  const readSecond = () => { try { return fs.readFileSync(SECOND, "utf8").trim(); } catch { return "(missing)"; } };
  const t4 = await prompt("Use the Write tool to create ./second.txt containing exactly: DELTA. Then reply with just: DONE");
  if (!t4.ok) throw new Error(t4.error);
  say("second.txt written", readSecond());
  const lastTurn = userTurns(transcript(sessionId)).at(-1)?.uuid;
  console.log(`  → cut first:   ${JSON.stringify(await adapter.rewindConversation(lastTurn, lastTurn))}`);
  console.log(`  → files after: ${JSON.stringify(await adapter.rewindFiles(lastTurn))}`);
  say("second.txt afterwards", readSecond());

  const after = await prompt("List every word you were ever told to write into note.txt, comma separated, nothing else.");
  say("conversation turn ok", after.ok ? "yes" : after.error);
  say("session id unchanged", adapter.metadata.sessionId === sessionId ? "yes" : `NO — ${adapter.metadata.sessionId}`);
} catch (e) {
  console.log(`\n  FAILED: ${e.message}`);
} finally {
  try { await adapter.stop(); } catch {}
  const dir = projectDir(sessionId);
  const f = transcript(sessionId);
  if (f) { try { fs.unlinkSync(f); } catch {} }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log("\n(temp session, transcript, project dir and cwd removed)");
  process.exit(0);
}
