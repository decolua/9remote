// The list's mounted window. The contract these pin: a message that arrives while the
// user is reading must never push an already-mounted one out of the DOM, or the pane
// grows a "load older" affordance mid-conversation with no reload involved — and the
// window must still be bounded, which is the whole reason paging exists.
//
// Run: node web/test/messageWindow.test.mjs
import assert from "node:assert/strict";
import {
  PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES,
  countMessagesByBudget, windowTop, estimateMessageBytes, opensMidTurn
} from "../features/ai/lib/messageWindow.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const msg = (id, content = "hello") => ({ id, role: "assistant", content });
// ~4 KB a piece, so a page of them lands just past the budget.
const bulky = (id) => msg(id, "x".repeat(4000));
const bytesOf = (list) => list.reduce((n, m) => n + estimateMessageBytes(m), 0);
// What the component does each render: mark the top, then mount from its index.
const step = (topId, messages, pageBytes = PAGE_BUDGET_BYTES) => {
  const top = windowTop(topId, messages, pageBytes, MAX_MOUNTED_BYTES);
  return { ...top, mounted: bytesOf(messages.slice(top.index)) };
};

console.log("Running messageWindow tests...");

test("a short chat mounts whole", () => {
  const messages = [msg("a"), msg("b")];
  assert.equal(step(null, messages).index, 0);
});

test("a long chat opens on roughly one page", () => {
  const messages = Array.from({ length: 60 }, (_, i) => bulky(String(i)));
  const { index } = step(null, messages);
  assert.ok(index > 0, "a 240 KB chat must page");
  // The budget is spent at the first message that crosses it, so a page overshoots by
  // at most one turn.
  assert.ok(messages.length - index <= PAGE_BUDGET_BYTES / 4000 + 1, `page too wide: ${messages.length - index}`);
});

test("appends never move the window's top down", () => {
  // The regression the user hit: the top was recomputed from the newest message each
  // render, so every append slid it down until turns appeared to fall off the top.
  let messages = Array.from({ length: 60 }, (_, i) => bulky(String(i)));
  let top = step(null, messages).id;
  for (let i = 60; i < 90; i++) {
    messages = [...messages, bulky(String(i))];
    top = step(top, messages).id;
  }
  assert.equal(top, "27", `top slid to ${top}`);
});

test("a page fetched on scroll-up is revealed", () => {
  let messages = Array.from({ length: 60 }, (_, i) => bulky(String(i)));
  const before = step(null, messages);
  // The host answers the fetch; its turns are prepended ahead of what the client holds.
  const older = Array.from({ length: 10 }, (_, i) => bulky(`old${i}`));
  messages = [...older, ...messages];
  // Asking for another page is what the component does then: drop the mark, wider budget.
  const { index } = step(null, messages, PAGE_BUDGET_BYTES * 2);
  // The top must land INSIDE the fetched prefix, or the turns just fetched stay hidden.
  assert.ok(index < older.length, `top is at ${index}, past the whole fetched page`);
  assert.ok(messages[index].id.startsWith("old"), `top is ${messages[index].id}`);
  // Two pages, plus the one turn the budget overshoots by.
  assert.ok(bytesOf(messages.slice(index)) <= PAGE_BUDGET_BYTES * 2 + 4000);
  assert.ok(before.index > 0, "sanity: the chat paged before the fetch too");
});

test("the ceiling bounds the DOM however long the chat runs", () => {
  let messages = [msg("0"), msg("1")];
  let top = step(null, messages).id;
  for (let i = 2; i < 400; i++) {
    messages = [...messages, bulky(`m${i}`)];
    top = step(top, messages).id;
  }
  const { index } = step(top, messages);
  assert.ok(index > 0, "a 400-turn chat must not mount from its head");
  assert.ok(bytesOf(messages.slice(index)) < MAX_MOUNTED_BYTES + 8000, "the ceiling did not bite");
});

// What the component does across a press: it drops the mark, raises the budget, then the
// effect stores the new mark and the next render HOLDS it. Both renders count — the bug
// lived in the second one, where a ceiling clamped the held mark back down.
const press = (heldId, messages, pageBytes) => {
  const fresh = step(null, messages, pageBytes);
  return { ...step(fresh.id, messages, pageBytes), fresh: fresh.index };
};

test("pressing load-older keeps moving the top past the ceiling", () => {
  // The regression after the ceiling was added: it clamped the top on EVERY render, so
  // once a chat's tail exceeded it the button raised a budget that no longer decided
  // anything — a few presses in, the top froze for good and the rest of the log was
  // unreachable. Only the held render catches it; asking with a null mark does not.
  // The agent keeps appending between presses, which is what makes the two budgets
  // diverge: the ceiling always measures the newest tail, the budget the fetched one.
  let messages = Array.from({ length: 400 }, (_, i) => bulky(String(i)));
  let page = PAGE_BUDGET_BYTES;
  let mark = null;
  let index = step(null, messages, page).index;
  const seen = [index];
  for (let n = 0; n < 400; n++) {
    messages = [...messages, bulky(`live${n}`), bulky(`live${n}b`)];
    page += PAGE_BUDGET_BYTES;
    const r = press(mark, messages, page);
    assert.equal(r.index, r.fresh, `press ${n + 1}: the held render clamped back to ${r.index}`);
    // Bounded either way: what the button bought, or the ceiling — whichever is wider.
    assert.ok(bytesOf(messages.slice(r.index)) <= Math.max(page, MAX_MOUNTED_BYTES) + 8000);
    mark = r.id;
    index = r.index;
    seen.push(index);
    if (index === 0) break;
  }
  assert.equal(seen.at(-1), 0, `the log stalled at ${seen.join(" → ")}`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] < seen[i - 1], `press ${i} did not move the top up: ${seen[i - 1]} → ${seen[i]}`);
  }
});

test("an unattended pane stays under the ceiling while the agent streams", () => {
  // The other half of the contract: with nobody paging, the ceiling still has to bite —
  // the budget never moves, so it is the only thing bounding a long-lived pane.
  let messages = [msg("0"), msg("1")];
  let mark = step(null, messages).id;
  for (let i = 2; i < 400; i++) {
    messages = [...messages, bulky(`m${i}`)];
    mark = step(mark, messages).id;
  }
  const { index } = step(mark, messages);
  assert.ok(index > 0, "a 400-turn chat must not mount from its head");
  assert.ok(bytesOf(messages.slice(index)) < MAX_MOUNTED_BYTES + 8000, "the ceiling did not bite");
});

test("a top the log no longer holds opens a fresh page — never the head", () => {
  // Hydrate renumbers every id, so this is the common case, not the rare one. Falling
  // back to index 0 mounted the whole session on every hydrate.
  const messages = Array.from({ length: 300 }, (_, i) => bulky(String(i)));
  const { index, mounted } = step("u-1-gone", messages);
  assert.ok(index > 0, "a dead mark mounted the whole list");
  assert.ok(mounted < MAX_MOUNTED_BYTES + 8000, `mounted ${mounted} bytes`);
  assert.equal(index, step(null, messages).index, "a dead mark must page like a fresh open");
});

test("an empty log has no top to mark", () => {
  assert.deepEqual(windowTop("a", [], PAGE_BUDGET_BYTES, MAX_MOUNTED_BYTES), { id: null, index: 0 });
});

test("countMessagesByBudget never returns an empty slice", () => {
  assert.equal(countMessagesByBudget([bulky("a")], PAGE_BUDGET_BYTES, undefined), 0);
});

// ── Opening on a turn, not mid-turn ──
// The host answers a hydrate with a byte-measured tail, and one agentic turn can run
// past that budget: a reopened chat then mounts a column of tool cards with no prompt
// above them, and the prompt only arrives if the reader pages up.

const userMsg = (id) => ({ id, role: "user", content: "hi" });

test("a window whose top is not a prompt asks for a page", () => {
  const messages = [bulky("tool-a"), bulky("tool-b"), userMsg("u-1"), bulky("tool-c")];
  assert.equal(opensMidTurn(messages, 0, true), true, "tools above the newest prompt");
});

test("a window that opens on a prompt asks for nothing", () => {
  const messages = [userMsg("u-1"), bulky("tool-a")];
  assert.equal(opensMidTurn(messages, 0, true), false, "the mounted window starts on the prompt");
  // Index 1 is the tool: the prompt sits above the mounted window, so it is mid-turn.
  assert.equal(opensMidTurn(messages, 1, true), true);
});

test("nothing hidden, but the top is still a card: the cap shed this log's prompts", () => {
  // The whole log is mounted and it holds no prompt at all — the head, where the prompts
  // lived, was shed. The host's older events are the only place one can come from.
  const messages = [bulky("tool-a"), bulky("tool-b")];
  assert.equal(opensMidTurn(messages, 0, true), true);
});

test("nothing hidden and the top is a prompt: nothing to fetch", () => {
  const messages = [userMsg("u-1"), bulky("tool-a")];
  assert.equal(opensMidTurn(messages, 0, true), false);
});

test("no older events on the host means nothing to ask for", () => {
  const messages = [bulky("tool-a")];
  assert.equal(opensMidTurn(messages, 0, false), false);
  assert.equal(opensMidTurn([], 0, true), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
