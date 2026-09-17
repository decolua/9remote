// Does the leaf pointer reach disk BEFORE the control request answers?
// reloadFromStore() reads the transcript the instant rewindConversation resolves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "/Users/Working/9remote/agent/features/ai/adapters/claudeAdapter.js";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-leaf-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const t = (sid) => { for (const e of (()=>{try{return fs.readdirSync(PROJECTS)}catch{return[]}})()) { const c = path.join(PROJECTS, e, `${sid}.jsonl`); if (fs.existsSync(c)) return c; } return null; };
const leafOf = (f) => { let l = null; try { for (const line of fs.readFileSync(f,"utf8").split("\n")) { try { const d=JSON.parse(line); if (d.type==="last-prompt"&&d.leafUuid) l=d.leafUuid; } catch {} } } catch {} return l; };
const turnsOf = (f) => { try { return fs.readFileSync(f,"utf8").split("\n").filter(l=>{try{const d=JSON.parse(l);return d.type==="user"&&!d.isSidechain&&d.uuid}catch{return false}}).length; } catch { return 0; } };

let adapter = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
const prompt = (text) => new Promise((res) => {
  const timer = setTimeout(() => res({ ok: false }), 180000);
  adapter.onEvent = (e, d) => { if (e!=="turn_complete"&&e!=="error") return; clearTimeout(timer); adapter.onEvent=()=>{}; res({ok:e!=="error"}); };
  adapter.sendPrompt(text);
});

let sid = null;
try {
  await adapter.start("bypassPermissions", null);
  for (const w of ["A","B","C"]) { if (!(await prompt(`Reply with just ${w}`)).ok) throw new Error("turn failed"); }
  sid = adapter.metadata.sessionId;
  const f = t(sid);
  const turns = fs.readFileSync(f,"utf8").split("\n").flatMap(l=>{try{const d=JSON.parse(l);return d.type==="user"&&!d.isSidechain&&d.uuid?[d.uuid]:[]}catch{return[]}});
  const target = turns[turns.length-1];
  console.log("before cut: leaf =", String(leafOf(f)).slice(0,8), "| user records:", turnsOf(f));

  const r = await adapter.rewindConversation(target, target);
  console.log("cut answered:", r.rewound, "| precedingAssistantUuid:", String(r.precedingAssistantUuid).slice(0,8), "| target:", String(target).slice(0,8));
  console.log("AT ANSWER  : leaf =", String(leafOf(f)).slice(0,8), "| matches target?", leafOf(f)===target ? "yes (leaf IS the cut turn)" : "leaf differs");
  for (const wait of [0,50,200,500,1500,4000]) {
    if (wait) await new Promise(r2=>setTimeout(r2,wait));
    console.log(`  +${wait}ms: leaf =`, String(leafOf(f)).slice(0,8), leafOf(f)===r.precedingAssistantUuid ? " <-- EQUALS precedingAssistantUuid" : "");
  }
} catch (e) { console.log("FAILED:", e.message); }
finally {
  try { await adapter.stop(); } catch {}
  const f = t(sid); const dir = f ? path.dirname(f) : null;
  if (f) { try { fs.unlinkSync(f); } catch {} }
  if (dir) { try { fs.rmSync(dir,{recursive:true,force:true}); } catch {} }
  try { fs.rmSync(CWD,{recursive:true,force:true}); } catch {}
  console.log("(cleaned)");
  process.exit(0);
}
