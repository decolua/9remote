// The paging contract against the REAL logs on this machine: whatever the host holds,
// scroll-up must reach its oldest event. Synthetic fixtures (web/test/aiReach.test.mjs)
// pin the shapes I could think of; this one runs the logs that actually accumulated —
// the capped ones, the ones whose seqs were renumbered, the 194-step turns.
//
// Skips cleanly when there are no snapshots (a fresh checkout, CI), so it never fails
// for want of data.
//
// Run: node agent/test/aiRealLogReach.e2e.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const real = path.join(os.homedir(), ".9remote", "ai-sessions");
const logs = fs.existsSync(real)
  ? fs.readdirSync(real).filter((f) => f.startsWith("claude-session-") && f.endsWith(".json"))
  : [];

console.log("Running real-log paging reachability...");
if (!logs.length) {
  console.log("  (no snapshots on this machine — skipping)");
  process.exit(0);
}

// A throwaway home: the constructor must read these through its own loader (which
// renumbers the log), and nothing here may write back to the user's files.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-reallog-"));
process.env.NREMOTE_HOME = home;
fs.mkdirSync(path.join(home, "ai-sessions"), { recursive: true });
for (const f of logs) fs.copyFileSync(path.join(real, f), path.join(home, "ai-sessions", f));

const { AiSession } = await import("../features/ai/aiSession.js");
const { aiTailStart, aiHistoryChunk } = await import("../features/ai/aiEventSlice.js");
const { AI_REPLAY_BYTES } = await import("../features/ai/constants.js");
const { windowTop, PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES } = await import(
  path.join(root, "web/features/ai/lib/messageWindow.js")
);

// The client's store shape, role-level: a prompt opens a bubble, the assistant segments
// that follow fold under it. Only the fields the window measures are needed.
function toMessages(events) {
  const out = [];
  let n = 0;
  for (const { event, data } of events) {
    const last = out[out.length - 1];
    if (event === "user_message") {
      out.push({ id: `u-${++n}`, role: "user", content: data?.text || "" });
      out.push({ id: `a-${++n}`, role: "assistant", content: "", isLive: true, tools: [] });
    } else if (event === "delta" || event === "thinking") {
      if (!last || last.role !== "assistant") out.push({ id: `m-${++n}`, role: "assistant", content: "", tools: [] });
      const m = out[out.length - 1];
      if (event === "delta") m.content += data?.text || "";
      else m.thinking = (m.thinking || "") + (data?.text || "");
    } else if (event === "tool_start") {
      if (last?.role === "assistant" && last.isLive && (last.content || last.thinking || "")) {
        last.isLive = false;
        out.push({ id: `m-${++n}`, role: "assistant", content: "", tools: [{ ...data }] });
      } else if (!last || last.role !== "assistant") {
        out.push({ id: `m-${++n}`, role: "assistant", content: "", tools: [{ ...data }] });
      } else (last.tools || (last.tools = [])).push({ ...data });
    } else if (event === "tool_result") {
      // The reducer scans back for the owning segment; an orphan (its start outside the
      // window) is dropped, exactly as the client drops it.
      for (let i = out.length - 1; i >= 0; i--) {
        const t = out[i].tools?.find((x) => x.id === data?.id);
        if (t) { Object.assign(t, data); break; }
      }
    } else if (event === "diff") {
      if (!last || last.role !== "assistant") out.push({ id: `m-${++n}`, role: "assistant", content: "", diffs: [data], tools: [] });
      else (out[out.length - 1].diffs || (out[out.length - 1].diffs = [])).push(data);
    } else if (event === "turn_complete") {
      for (const m of out) if (m.isLive) m.isLive = false;
    }
  }
  return out;
}

// What the pane does: window, ask the host when nothing older is held, press (raise the
// budget). Reaching index 0 with no host events left is the contract.
function walkUp(full) {
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const ack = from > 0 ? full.slice(from) : full;
  let hasOlder = from > 0;
  let oldest = ack[0]?.seq ?? 0;
  let messages = toMessages(ack);
  let page = PAGE_BUDGET_BYTES;
  let mark = null;
  for (let i = 0; i < 600; i++) {
    const top = windowTop(mark, messages, page, MAX_MOUNTED_BYTES);
    if (top.index === 0 && hasOlder) {
      const chunk = aiHistoryChunk(full, oldest, AI_REPLAY_BYTES);
      // An empty page with events still owed is the dead-affordance bug: nothing the
      // reader presses can move.
      if (!chunk.events.length) return { reached: false, why: `empty page at seq ${oldest}` };
      messages = [...toMessages(chunk.events), ...messages];
      oldest = chunk.events[0].seq;
      hasOlder = chunk.hasMore;
    }
    mark = null;
    page += PAGE_BUDGET_BYTES;
    const after = windowTop(mark, messages, page, MAX_MOUNTED_BYTES);
    if (after.index === 0 && !hasOlder) return { reached: true, top: after, messages };
  }
  return { reached: false, why: "paging never settled" };
}

let pass = 0, fail = 0;
for (const f of logs) {
  const id = f.replace(/^claude-|\.json$/g, "");
  try {
    const s = new AiSession({ id, engine: "claude", cwd: process.cwd(), options: { mock: true }, onEvent() {} });
    const full = s.history;
    assert.ok(Array.isArray(full), "no log");
    if (!full.length) { pass++; continue; }
    const { reached, why, top, messages } = walkUp(full);
    assert.ok(reached, `${f}: ${why}`);
    assert.equal(top.index, 0, `${f}: stopped at index ${top.index}`);
    // A log of pure metadata (an `init` and nothing else) mounts nothing, and that is
    // correct — there is no turn in it to show. Anything with a turn must mount one.
    const hasTurn = full.some((e) => e.event === "user_message" || e.event === "delta" || e.event === "tool_start");
    if (hasTurn) assert.ok(messages.length > 0, `${f}: a log with turns mounted nothing`);
    pass++;
  } catch (err) {
    fail++;
    console.error(`  ✗ ${f}\n    ${err.message}`);
  }
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`  ✓ ${pass} logs page to their oldest event${fail ? `, ${fail} failed` : ""}`);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
