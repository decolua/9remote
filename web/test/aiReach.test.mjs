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
  aiTailStart, aiHistoryChunk, windowBytes, replayWindow
} from "../../agent/features/ai/aiEventSlice.js";
import { AI_REPLAY_BYTES } from "../../agent/features/ai/constants.js";
import {
  PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES, MAX_AUTO_PAGES, windowTop, opensMidTurn, estimateMessageBytes
} from "../features/ai/lib/messageWindow.js";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { collectOlderPage } from "../features/ai/lib/olderPaging.js";

// The budget one scroll-up tap spends, mirrored from useAiSession (OLDER_PAGE_BYTES).
const OLDER_PAGE_BYTES = 128 * 1024;

let pass = 0, fail = 0;
// Collected, not awaited inline: several cases are async now (they drive the real paging
// loop), and a bare `await` in a top-level test call would print the ✓ before the run.
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

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

test("a fresh chat's first prompt is within the open-time fetch's reach", () => {
  // A chat that has just started has no prompts in its log at all — the events between
  // prompts are a run of tool calls, and each chunk of them reduces to ONE message. So a
  // page buys one card, and reaching the first prompt takes as many pages as there were
  // tool runs. Measured on three real fresh chats: 7 and 9 pages.
  //
  // The cap was 6, chosen from logs that had already accumulated their prompts — so on a
  // chat that had not, the pane stopped one screen of cards short with nothing to scroll.
  assert.ok(MAX_AUTO_PAGES >= 12, `the cap (${MAX_AUTO_PAGES}) must clear a fresh chat's first prompt`);

  // And the loop it guards really is self-terminating, which is what makes a large cap
  // safe: this walk is driven by hasMore, not by a page count.
  const full = log(14, 6);
  const { reached } = walkUp(full);
  assert.ok(reached, "the guard must never be what stops the walk");
});

test("the open-time fetch is bounded by the host running out, not by the cap", () => {
  // A log whose turns all sit behind one window still terminates: the walk ends when
  // `hasMore` goes false, so no cap is load-bearing for correctness.
  const full = turn(1, 300).map((e, i) => ({ ...e, seq: i + 1 }));
  const { reached, history } = walkUp(full);
  assert.ok(reached, "a single enormous turn must still settle");
  assert.ok(history.length < 200, `walked ${history.length} rounds — is it terminating?`);
});

// ── the loadOlder loop itself, not a model of it ──────────────────────────────
//
// `walkUp` above re-implements paging; a bug in the real loop then hides behind it. This
// drives the loop's own rules against the real chunker and the real reducer, because that
// is where the reported bug lived: a chunk the reducer turned into NOTHING was treated as
// the end of history, so scroll-up stopped on the first one it met.
//
// A `cli_event` the pane draws NOTHING for. `edited_text_file` without a filename, a
// `hook_success` that is not a SessionStart, a `task_reminder` — the reducer reads each
// through `noticeFrom`, which returns null, so a chunk of these reduces to zero messages.
// That is the case that ended the walk: not a chunk that draws too little, one that draws
// nothing at all, and it is the common one (measured: 24 of 238 chunks on a real chat).
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

// One turn: a numbered prompt, a tool call with its result, then `filler` attachment-only
// events. The fillers are what a page fills up with — a whole 32KB chunk of them reduces
// to nothing, which is exactly the chunk the old walk treated as the end of history.
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

// The client's loop, the REAL one — lib/olderPaging is what useAiSession.loadOlder runs,
// so this drives the code that ships rather than a transcription of it. (A transcription
// is what let the dead scroll-up pass its own reachability test: it was written in a
// kinder order than the real loop, and the real loop's order is the bug.)
async function loadOlderWalk(full) {
  const ack = replayWindow(full, AI_REPLAY_BYTES);
  const prompts = new Set();
  for (const e of ack.events) if (e.event === "user_message") prompts.add(e.data.text);
  let before = ack.fromSeq;
  for (let tap = 0; tap < 500; tap++) {
    const r = await collectOlderPage({
      startSeq: before,
      estimateBytes: estimateMessageBytes,
      // The wire shape, not the chunker's own return — the host wraps it (SessionHandler:
      // `callback({ success: true, events, hasMore })`), and the loop reads the ack.
      fetchChunk: async (b) => {
        const c = aiHistoryChunk(full, b, AI_REPLAY_BYTES);
        return { success: true, events: c.events, hasMore: c.hasMore };
      },
      reduceChunk: (events, held) => reduceSessionEvents(events, "claude", held + 1).messages
    });
    for (const m of r.messages) if (m.role === "user") prompts.add(m.content);
    if (!r.answered || r.before === before) break;   // nothing moved: the walk is over
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
