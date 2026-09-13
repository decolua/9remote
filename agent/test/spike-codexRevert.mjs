// Spike 3: pin down what thread/revert's beforeTurnId actually means.
//
// Spike 2 passed the 2nd turn's id and the result KEPT turns 3..7 — i.e. it discarded
// the beginning, which is the opposite of a rewind. Getting this backwards in the real
// feature would delete the wrong half of someone's conversation, so it is worth three
// forks to be sure.
//
// Run: node agent/test/spike-codexRevert.mjs
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

let nextId = 1;
let buffer = "";

function rpc(child, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const userOf = (t) =>
  (t.items || []).find((i) => i.type === "userMessage")?.content?.find((c) => c.type === "text")?.text?.slice(0, 30) || "";

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", () => {});
child.stdin.on("error", () => process.exit(1));
const notify = (m, p = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: m, params: p })}\n`);

await rpc(child, "initialize", { clientInfo: { name: "9remote-spike", version: "1.0.0" }, capabilities: { experimentalApi: true } });
notify("initialized", {});

const listTurns = async (id) => (await rpc(child, "thread/turns/list", { threadId: id, limit: 50 }))?.data || [];

// A readable multi-turn thread.
const db = new DatabaseSync(path.join(os.homedir(), ".codex", "thread_history_1.sqlite"), { readOnly: true });
const rows = db.prepare("select thread_id, count(*) c from thread_turns group by thread_id order by c desc limit 12").all();
db.close();

let target = null;
for (const r of rows) {
  try {
    const turns = await listTurns(r.thread_id);
    if (turns.length >= 5) { target = { id: r.thread_id, turns }; break; }
  } catch { /* unreadable lineage */ }
}
if (!target) { console.log("no readable thread"); child.kill(); process.exit(0); }

const ids = target.turns.map((t) => t.id);
console.log(`thread ${target.id.slice(0, 8)} — ${ids.length} turns`);
console.log("order:", target.turns.map((t, i) => `${i + 1}:${userOf(t)}`).join(" | "));

/**
 * Fork the original at one turn and report which user messages the fork carries.
 * A rewind wants the PREFIX (everything before the chosen turn).
 */
async function probe(label, turnIndex, method, field) {
  const turnId = ids[turnIndex];
  let err = null;
  let fork = null;
  try {
    const params = { threadId: target.id, [field]: turnId };
    const r = await rpc(child, "thread/fork", params);
    fork = r?.thread?.id;
  } catch (e) {
    err = e.message;
  }
  const after = err || !fork ? [] : await listTurns(fork).catch(() => []);
  const kept = after.map(userOf);
  const expectedRewind = target.turns.slice(0, turnIndex).map(userOf);
  const isRewind = kept.length === expectedRewind.length && kept.every((v, i) => v === expectedRewind[i]);
  console.log(`\n${label} — ${method} ${field} = turn #${turnIndex + 1} ("${userOf(target.turns[turnIndex])}")`);
  if (err) console.log(`  ERROR: ${err}`);
  else {
    console.log(`  kept:     [${kept.join(" | ")}]`);
    console.log(`  rewind ⇒  [${expectedRewind.join(" | ")}]`);
    console.log(`  verdict:  ${isRewind ? "✓ REWIND — kept the prefix" : "✗ not a rewind"}`);
  }
  return { kept, isRewind };
}

await probe("fork lastTurnId@3", 2, "thread/fork", "lastTurnId");
await probe("fork lastTurnId@5", 4, "thread/fork", "lastTurnId");
await probe("fork lastTurnId@2", 1, "thread/fork", "lastTurnId");

child.kill();
console.log("\ndone");
