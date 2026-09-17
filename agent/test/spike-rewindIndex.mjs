// Spike: does `rewind_conversation` accept a target that is NOT the newest turn?
//
// The reported bug, in the user's words: rewinding the LAST user message works, rewinding
// an earlier one does nothing at all. The host's index→uuid mapping was measured correct
// against the pane, so the refusal has to be the CLI's own — and it is invisible on screen
// because the client reverts its log either way.
//
// The two cases differ in exactly one thing: with a target behind the newest turn,
// `last_seen_user_message_uuid` is NOT the target, and the CLI has to accept a cut that
// drops turns it has already seen. That is the case this measures.
//
// Run: node agent/test/spike-rewindIndex.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../features/ai/adapters/claudeAdapter.js";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-idx-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const say = (l, v) => console.log(`  ${l.padEnd(30)} ${v}`);

function transcript(sid) {
  if (!sid) return null;
  for (const entry of (() => { try { return fs.readdirSync(PROJECTS); } catch { return []; } })()) {
    const c = path.join(PROJECTS, entry, `${sid}.jsonl`);
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const userTurns = (f) => {
  let raw = "";
  try { raw = fs.readFileSync(f, "utf8"); } catch { return []; }
  return raw.split("\n").flatMap((l) => {
    try {
      const d = JSON.parse(l);
      if (d.type !== "user" || d.isSidechain || !d.uuid) return [];
      const c = d.message?.content;
      const t = typeof c === "string" ? c : (c || []).find((b) => b?.type === "text")?.text || "";
      return t ? [{ uuid: d.uuid, text: t }] : [];
    } catch { return []; }
  });
};

let adapter = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
let sessionId = null;

function prompt(text) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 180000);
    adapter.onEvent = (e, d) => {
      if (e !== "turn_complete" && e !== "error") return;
      clearTimeout(timer);
      adapter.onEvent = () => {};
      resolve(e === "error" ? { ok: false, error: d?.message } : { ok: true });
    };
    adapter.sendPrompt(text);
  });
}

/**
 * A fresh conversation of `words.length` turns, with its adapter still running.
 *
 * Each case needs its OWN session: a cut removes the turns behind it, so reusing one
 * conversation made case 2 report `target_not_found` for a turn case 1 had already
 * dropped, which says nothing about the case being measured.
 */
async function freshTurns(words) {
  const a = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
  adapter = a;
  await a.start("bypassPermissions", null);
  for (const w of words) {
    const r = await prompt(`Reply with just the word ${w} and nothing else.`);
    if (!r.ok) throw new Error(r.error);
  }
  const id = a.metadata.sessionId;
  const turns = userTurns(transcript(id));
  return { id, turns };
}

console.log("Running rewind-index spike...\n");
try {
  // ── 1. target IS the newest turn — the case the user says works ──
  console.log("1. target = NEWEST turn");
  const s1 = await freshTurns(["ALPHA", "BRAVO", "CHARLIE"]);
  sessionId = s1.id;
  {
    const { uuid } = s1.turns.at(-1);
    say("turns", s1.turns.map((t) => t.uuid.slice(0, 6)).join(" "));
    say("target / lastSeen", `${uuid.slice(0, 8)} / ${uuid.slice(0, 8)}`);
    say("result", JSON.stringify(await adapter.rewindConversation(uuid, uuid)));
    await adapter.stop();
  }

  // ── 2. target is an EARLIER turn, lastSeen is the newest — what the host sends ──
  console.log("\n2. target = SECOND NEWEST turn, lastSeen = newest");
  const s2 = await freshTurns(["ALPHA", "BRAVO", "CHARLIE"]);
  sessionId = s2.id;
  {
    const target = s2.turns.at(-2).uuid;
    const lastSeen = s2.turns.at(-1).uuid;
    say("turns", s2.turns.map((t) => t.uuid.slice(0, 6)).join(" "));
    say("target / lastSeen", `${target.slice(0, 8)} / ${lastSeen.slice(0, 8)}`);
    say("result", JSON.stringify(await adapter.rewindConversation(target, lastSeen)));
    await adapter.stop();
  }

  // ── 3. the same cut, with lastSeen = the target itself ──
  console.log("\n3. target = SECOND NEWEST, lastSeen = the target");
  const s3 = await freshTurns(["ALPHA", "BRAVO", "CHARLIE"]);
  sessionId = s3.id;
  {
    const target = s3.turns.at(-2).uuid;
    say("turns", s3.turns.map((t) => t.uuid.slice(0, 6)).join(" "));
    say("target / lastSeen", `${target.slice(0, 8)} / ${target.slice(0, 8)}`);
    say("result", JSON.stringify(await adapter.rewindConversation(target, target)));
    await adapter.stop();
  }
} catch (e) {
  console.log(`\n  FAILED: ${e.message}`);
} finally {
  try { await adapter.stop(); } catch {}
  const f = transcript(sessionId);
  const dir = f ? path.dirname(f) : null;
  if (f) { try { fs.unlinkSync(f); } catch {} }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log("\n(cleaned up)");
  process.exit(0);
}
