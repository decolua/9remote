import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "/Users/Working/9remote/agent/features/ai/adapters/claudeAdapter.js";
import { recoverFromClaudeTranscript as recover } from "/Users/Working/9remote/agent/features/ai/claudeTranscript.js";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "9r-verify-"));
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const t = (sid) => { for (const e of (()=>{try{return fs.readdirSync(PROJECTS)}catch{return[]}})()) { const c = path.join(PROJECTS,e,`${sid}.jsonl`); if (fs.existsSync(c)) return c; } return null; };

let adapter = new ClaudeAdapter({ cwd: CWD, onEvent: () => {}, hostSessionId: "" });
const prompt = (text) => new Promise((res) => {
  const timer = setTimeout(() => res({ok:false}), 180000);
  adapter.onEvent = (e,d) => { if (e!=="turn_complete"&&e!=="error") return; clearTimeout(timer); adapter.onEvent=()=>{}; res({ok:e!=="error"}); };
  adapter.sendPrompt(text);
});
const words = (ev) => (ev||[]).filter(e=>e.event==="user_message").map(e=>e.data.text.slice(0,26));

let sid=null;
try {
  await adapter.start("bypassPermissions", null);
  for (const w of ["ONE","TWO","THREE"]) if (!(await prompt(`Reply with just ${w}`)).ok) throw new Error("turn failed");
  sid = adapter.metadata.sessionId;
  const f = t(sid);
  const turns = fs.readFileSync(f,"utf8").split("\n").flatMap(l=>{try{const d=JSON.parse(l);return d.type==="user"&&!d.isSidechain&&d.uuid?[d.uuid]:[]}catch{return[]}});
  const target = turns[turns.length-1];

  const before = words(recover(CWD, sid));
  console.log("before cut               :", JSON.stringify(before));

  const cut = await adapter.rewindConversation(target, target);
  console.log("cut:", cut.rewound);

  // Read IMMEDIATELY — the window the product's reloadFromStore lands in.
  console.log("rebuild, no override     :", JSON.stringify(words(recover(CWD, sid))), "  <-- the bug");
  console.log("rebuild, WITH override   :", JSON.stringify(words(recover(CWD, sid, 1, cut.precedingAssistantUuid))), "  <-- the fix");

  await new Promise(r=>setTimeout(r,400));
  console.log("after the pointer lands  :", JSON.stringify(words(recover(CWD, sid))));
} catch(e) { console.log("FAILED:", e.message); }
finally {
  try { await adapter.stop(); } catch {}
  const f = t(sid); const dir = f ? path.dirname(f) : null;
  if (f) { try { fs.unlinkSync(f); } catch {} }
  if (dir) { try { fs.rmSync(dir,{recursive:true,force:true}); } catch {} }
  try { fs.rmSync(CWD,{recursive:true,force:true}); } catch {}
  console.log("(cleaned)"); process.exit(0);
}
