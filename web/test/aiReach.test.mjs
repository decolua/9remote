// The paging contract: whatever the host holds, scroll-up reaches the FIRST event — and
// the reader is never handed an affordance that cannot move. This is the reachability
// proof for the chat pane, so it is driven by the real windowing code on both sides
// (agent's aiEventSlice, web's messageWindow) rather than a model of them.
//
// The affordance: the button/observer is armed on `hiddenCount > 0 || hasOlder`, and
// pressing it reveals a page of what is ALREADY held before it asks the host for more.
// That in-RAM half is what makes a window full of tools paging down to one screen still
// scrollable — the button is there before the host has anything to add.
//
// Run: node web/test/aiReach.test.mjs
import assert from "node:assert/strict";
import {
  aiTailStart, aiHistoryChunk, windowBytes
} from "../../agent/features/ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../../agent/features/ai/constants.js";
import {
  PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES, windowTop, opensMidTurn
} from "../features/ai/lib/messageWindow.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
const user = (seq, text = "prompt") => ({ seq, event: "user_message", data: { text } });
const tool = (seq, id, out = 3000) => ({ seq, event: "tool_start", data: { id, name: "Bash", input: { command: "x" } }, _out: out });
const result = (seq, id, out = 3000) => ({ seq, event: "tool_result", data: { id, output: "y".repeat(out) } });
const done = (seq) => ({ seq, event: "turn_complete", data: { stats: {} } });

// One turn of `steps` tool calls, each with its result, ending the turn.
const turn = (startSeq, steps) => {
  const out = [user(startSeq)];
  for (let i = 0; i < steps; i++) {
    out.push(tool(startSeq + 1 + i * 2, `t${startSeq}_${i}`));
    out.push(result(startSeq + 2 + i * 2, `t${startSeq}_${i}`));
  }
  out.push(done(startSeq + 1 + steps * 2));
  return out;
};
const log = (turns, steps) => {
  const out = [];
  let seq = 1;
  for (let i = 0; i < turns; i++) {
    const t = turn(seq, steps);
    out.push(...t);
    seq += t.length;
  }
  return out;
};

// The client's store shape, role-level only: a prompt opens a bubble and the assistant
// segments that follow fold under it.
const toMessages = (events) => {
  const out = [];
  let n = 0;
  for (const { event, data } of events) {
    const last = out[out.length - 1];
    if (event === "user_message") {
      out.push({ id: `u-${++n}`, role: "user", content: data?.text || "" });
      out.push({ id: `a-${++n}`, role: "assistant", content: "", isLive: true, tools: [] });
    } else if (event === "tool_start") {
      if (last?.role === "assistant" && last.isLive && (last.content || last.thinking || "")) {
        last.isLive = false;
        out.push({ id: `m-${++n}`, role: "assistant", content: "", tools: [{ ...data }] });
      } else if (!last || last.role !== "assistant") {
        out.push({ id: `m-${++n}`, role: "assistant", content: "", tools: [{ ...data }] });
      } else (last.tools || (last.tools = [])).push({ ...data });
    } else if (event === "turn_complete") {
      for (const m of out) if (m.isLive) m.isLive = false;
    }
  }
  return out;
};

// What the pane does, driven by the real component's rules:
//   - the window is windowTop(mark, messages, pageBytes, ceiling)
//   - load-more asks the host ONLY when nothing is hidden, then raises the budget
//   - the button/observer is armed on hiddenCount > 0 || hasOlder
const walkUp = (full) => {
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const ack = from > 0 ? full.slice(from) : full;
  let hasOlder = from > 0;
  let oldestHeld = ack[0]?.seq ?? 0;
  let messages = toMessages(ack);
  let page = PAGE_BUDGET_BYTES;
  let mark = null;
  const history = [];
  for (let i = 0; i < 500; i++) {
    const top = windowTop(mark, messages, page, MAX_MOUNTED_BYTES);
    history.push(top.index);
    // The sentinel: nothing mounted older AND the host has more means the in-RAM button
    // is not what the reader needs — the host is asked.
    if (top.index === 0 && hasOlder) {
      const chunk = aiHistoryChunk(full, oldestHeld, AI_REPLAY_BYTES);
      if (!chunk.events.length) break;
      messages = [...toMessages(chunk.events), ...messages];
      oldestHeld = chunk.events[0].seq;
      hasOlder = chunk.hasMore;
    }
    // The press.
    mark = null;
    page += PAGE_BUDGET_BYTES;
    const after = windowTop(mark, messages, page, MAX_MOUNTED_BYTES);
    if (after.index === 0 && !hasOlder) return { reached: true, messages, history, top: after };
  }
  return { reached: false, messages, history, top: windowTop(null, messages, page, MAX_MOUNTED_BYTES) };
};

console.log("Running AI paging reachability tests...");

test("scroll-up reaches the first event of a 100-step turn", () => {
  const full = log(3, 100);
  const { reached, messages, top } = walkUp(full);
  assert.ok(reached, `never reached the top (history: ${top.index})`);
  assert.equal(messages[top.index]?.role, "user", "the top of the thread is the first prompt");
  assert.equal(messages[top.index].content, "prompt");
});

test("scroll-up reaches the first event when one turn is 50 windows wide", () => {
  // The worst real shape: a single turn of tool calls whose events dwarf the whole
  // per-window budget many times over.
  const full = turn(1, 300);
  const total = windowBytes(full);
  // Measured: a real 194-step turn ran 473KB, so this is the shape, not an exaggeration.
  assert.ok(total > PAGE_BUDGET_BYTES * 3, `sanity: turn is only ${(total / 1024).toFixed(0)}KB`);
  const { reached, top, messages } = walkUp(full);
  assert.ok(reached, "the only prompt in the log must be reachable");
  assert.equal(messages[top.index]?.role, "user");
});

test("a window that is all tools still offers a way to move", () => {
  // The case read as "no scroll": the mounted window is nothing but cards, so there is
  // no bubble to recognise and little to drag. The affordance is armed by the host's own
  // `hasMore` or by a hidden count — never by the absence of a bubble.
  const full = log(6, 40);
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const messages = toMessages(full.slice(from));
  const top = windowTop(null, messages, PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES);
  const hidden = top.index;
  assert.ok(hidden > 0 || from > 0, "neither a hidden count nor hasMore: no affordance to press");
  assert.equal(messages[top.index].role !== "user", opensMidTurn(messages, hidden, from > 0));
});

test("a window with nothing hidden but no prompt still arms the bar, and the press moves", () => {
  // The case read as "no scroll": the mounted window is a column of cards, shorter than
  // the screen, with the prompts all above it. Nothing in RAM is hidden (hiddenCount 0),
  // so the bar is armed by the host's own `hasMore` — and the press has to move the
  // reader, not just re-ask.
  const full = log(8, 40);
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const messages = toMessages(full.slice(from));
  const top = windowTop(null, messages, PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES);
  assert.equal(top.index, 0, "sanity: the ack window is entirely mounted");
  assert.ok(messages[0]?.role !== "user", "sanity: it opens on a card");
  assert.ok(from > 0, "and the host still holds older events — that is what arms the bar");
  // Pressing it runs the whole walk: every older event must end up reachable, or the bar
  // was pointing at nothing.
  assert.equal(walkUp(full).reached, true, "the bar must lead somewhere");
});

test("a log the cap already shed still pages to its oldest event", () => {
  // What AI_MAX_EVENTS leaves behind: a headless tail. Its first event is a tool result,
  // and that is the floor — reachable is the contract, a prompt is not owed.
  const full = turn(1, 200).slice(60).map((e, i) => ({ ...e, seq: i + 1 }));
  assert.equal(full.filter((e) => e.event === "user_message").length, 0, "sanity: no prompt left");
  const { reached, top } = walkUp(full);
  assert.ok(reached, "the oldest event in the log must be reachable");
  assert.equal(top.index, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
