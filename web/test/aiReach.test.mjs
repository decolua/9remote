// Run: node web/test/aiReach.test.mjs
// Verifies chat pane paging reaches the first event through windowing and olderPaging.
import assert from "node:assert/strict";
import {
  aiTailStart, aiHistoryChunk, windowBytes, replayWindow
} from "../../agent/features/ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../../agent/features/ai/constants.js";
import {
  PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES, MAX_AUTO_PAGES, windowTop, opensMidTurn, estimateMessageBytes
} from "../features/ai/lib/messageWindow.js";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { collectOlderPage } from "../features/ai/lib/olderPaging.js";

const OLDER_PAGE_BYTES = 128 * 1024;

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const user = (seq, text = "prompt") => ({ seq, event: "user_message", data: { text } });
const tool = (seq, id, out = 3000) => ({ seq, event: "tool_start", data: { id, name: "Bash", input: { command: "x" } }, _out: out });
const result = (seq, id, out = 3000) => ({ seq, event: "tool_result", data: { id, output: "y".repeat(out) } });
const done = (seq) => ({ seq, event: "turn_complete", data: { stats: {} } });

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
    if (top.index === 0 && hasOlder) {
      const chunk = aiHistoryChunk(full, oldestHeld, AI_REPLAY_BYTES);
      if (!chunk.events.length) break;
      messages = [...toMessages(chunk.events), ...messages];
      oldestHeld = chunk.events[0].seq;
      hasOlder = chunk.hasMore;
    }
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
  const full = turn(1, 300);
  const total = windowBytes(full);
  assert.ok(total > PAGE_BUDGET_BYTES * 3, `sanity: turn is only ${(total / 1024).toFixed(0)}KB`);
  const { reached, top, messages } = walkUp(full);
  assert.ok(reached, "the only prompt in the log must be reachable");
  assert.equal(messages[top.index]?.role, "user");
});

test("a window that is all tools still offers a way to move", () => {
  const full = log(6, 40);
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const messages = toMessages(full.slice(from));
  const top = windowTop(null, messages, PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES);
  const hidden = top.index;
  assert.ok(hidden > 0 || from > 0, "neither a hidden count nor hasMore: no affordance to press");
  assert.equal(messages[top.index].role !== "user", opensMidTurn(messages, hidden, from > 0));
});

test("a window with nothing hidden but no prompt still arms the bar, and the press moves", () => {
  const full = log(8, 40);
  const from = aiTailStart(full, AI_REPLAY_BYTES);
  const messages = toMessages(full.slice(from));
  const top = windowTop(null, messages, PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES);
  assert.equal(top.index, 0, "sanity: the ack window is entirely mounted");
  assert.ok(messages[0]?.role !== "user", "sanity: it opens on a card");
  assert.ok(from > 0, "and the host still holds older events — that is what arms the bar");
  assert.equal(walkUp(full).reached, true, "the bar must lead somewhere");
});

test("a log the cap already shed still pages to its oldest event", () => {
  const full = turn(1, 200).slice(60).map((e, i) => ({ ...e, seq: i + 1 }));
  assert.equal(full.filter((e) => e.event === "user_message").length, 0, "sanity: no prompt left");
  const { reached, top } = walkUp(full);
  assert.ok(reached, "the oldest event in the log must be reachable");
  assert.equal(top.index, 0);
});

test("a fresh chat's first prompt is within the open-time fetch's reach", () => {
  assert.ok(MAX_AUTO_PAGES >= 12, `the cap (${MAX_AUTO_PAGES}) must clear a fresh chat's first prompt`);
  const full = log(14, 6);
  const { reached } = walkUp(full);
  assert.ok(reached, "the guard must never be what stops the walk");
});

test("the open-time fetch is bounded by the host running out, not by the cap", () => {
  const full = turn(1, 300).map((e, i) => ({ ...e, seq: i + 1 }));
  const { reached, history } = walkUp(full);
  assert.ok(reached, "a single enormous turn must still settle");
  assert.ok(history.length < 200, `walked ${history.length} rounds — is it terminating?`);
});

const attachment = (seq, kb) => ({
  seq, event: "cli_event",
  data: {
    type: "attachment", subtype: "task_reminder",
    record: {
      rendered: [{ content: "r".repeat(kb * 1024) }],
      attachment: { type: "task_reminder", content: "x".repeat(kb * 1024), itemCount: 3 }
    }
  }
});

const turnWithFiller = (startSeq, steps, filler, n) => {
  const out = [{ seq: startSeq, event: "user_message", data: { text: `prompt ${n}` } }];
  for (let i = 0; i < steps; i++) {
    out.push(tool(startSeq + 1 + i * 2, `t${startSeq}_${i}`));
    out.push(result(startSeq + 2 + i * 2, `t${startSeq}_${i}`));
  }
  out.push(done(startSeq + 1 + steps * 2));
  let seq = startSeq + out.length;
  for (let i = 0; i < filler; i++) out.push(attachment(seq++, 9));
  return out;
};

async function loadOlderWalk(full) {
  const ack = replayWindow(full, AI_REPLAY_BYTES);
  const prompts = new Set();
  for (const e of ack.events) if (e.event === "user_message") prompts.add(e.data.text);
  let before = ack.fromSeq;
  for (let tap = 0; tap < 500; tap++) {
    const r = await collectOlderPage({
      startSeq: before,
      estimateBytes: estimateMessageBytes,
      fetchChunk: async (b) => {
        const c = aiHistoryChunk(full, b, AI_REPLAY_BYTES);
        return { success: true, events: c.events, hasMore: c.hasMore };
      },
      reduceChunk: (events, held) => reduceSessionEvents(events, "claude", held + 1).messages
    });
    for (const m of r.messages) if (m.role === "user") prompts.add(m.content);
    if (!r.answered || r.before === before) break;
    before = r.before;
  }
  return prompts;
}

test("a chunk of nothing-drawable records does not end the walk", async () => {
  // The reported bug, in miniature: pages made only of `edited_text_file` attachments
  // reduce to a notice or to nothing at all. Ending on that cost the pane its history —
  // 0 of 76 prompts reachable on a real chat.
  const full = [];
  let seq = 1;
  for (let i = 0; i < 12; i++) {
    const t = turnWithFiller(seq, 3, 6, i + 1);
    full.push(...t);
    seq += t.length;
  }
  const reached = await loadOlderWalk(full);
  for (let i = 1; i <= 12; i++) {
    assert.ok(reached.has(`prompt ${i}`), `prompt ${i} is unreachable`);
  }
});

test("every prompt of a 40-turn chat filled with attachments is reachable", async () => {
  const full = [];
  let seq = 1;
  for (let i = 0; i < 40; i++) {
    const t = turnWithFiller(seq, 2, 4, i + 1);
    full.push(...t);
    seq += t.length;
  }
  const reached = await loadOlderWalk(full);
  assert.equal(reached.size, 40, `reached ${reached.size} of 40 prompts`);
});

for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
