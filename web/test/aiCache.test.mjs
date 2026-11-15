// Best-effort local cache of the AI pane's replay tail (web/features/ai/lib/aiCache.js).
// Contract: the cache is never authoritative — it must be cheap to validate, bounded,
// and safe to drop. Every decision here is pure so the rules are pinnable without a DOM.
//
// Run: node --import ./test/loader-alias.mjs web/test/aiCache.test.mjs
import assert from "node:assert/strict";
import {
  AI_CACHE_SCHEMA,
  AI_CACHE_MAX_BYTES,
  AI_CACHE_MAX_AGE_MS,
  cacheKey,
  eventBytes,
  trimTail,
  appendTail,
  buildCacheEntry,
  parseCacheEntry,
  shouldUseCachedSnapshot,
  selectPrunable
} from "../features/ai/lib/aiCache.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

const ev = (seq, text = "x") => ({ seq, event: "delta", data: { text }, epoch: 7 });

console.log("Running aiCache tests...");

test("cacheKey namespaces by host and falls back for the local host", () => {
  assert.equal(cacheKey("abc123", "session-1"), "abc123:session-1");
  assert.equal(cacheKey("", "session-1"), "local:session-1");
  assert.equal(cacheKey(null, "session-1"), "local:session-1");
});

test("eventBytes counts the envelope the reducer will read", () => {
  const a = eventBytes({ seq: 1, event: "delta", data: { text: "abc" } });
  assert.ok(a > 10);
  assert.ok(a < 200);
});

test("trimTail keeps a short tail whole", () => {
  const tail = trimTail([ev(1), ev(2), ev(3)], AI_CACHE_MAX_BYTES);
  assert.deepEqual(tail.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(tail.firstSeq, 1);
  assert.equal(tail.hasMore, false);
  assert.ok(tail.bytes > 0);
});

test("trimTail keeps the newest suffix under the cap", () => {
  const events = Array.from({ length: 50 }, (_, i) => ev(i + 1, "y".repeat(40)));
  const one = eventBytes(events[0]);
  const tail = trimTail(events, one * 5);
  assert.equal(tail.events.length, 5);
  assert.deepEqual(tail.events.map((e) => e.seq), [46, 47, 48, 49, 50]);
  assert.equal(tail.firstSeq, 46);
  assert.equal(tail.hasMore, true);
  assert.ok(tail.bytes <= one * 5);
});

test("trimTail stops at an event too wide to fit rather than splitting it", () => {
  const huge = ev(1, "z".repeat(4096));
  const tail = trimTail([huge, ev(2)], 100);
  assert.deepEqual(tail.events.map((e) => e.seq), [2]);
  assert.equal(tail.hasMore, true);
});

test("trimTail on an empty list is empty and not 'more'", () => {
  assert.deepEqual(trimTail([], 100), { events: [], bytes: 0, firstSeq: 0, hasMore: false });
});

test("appendTail grows a null tail", () => {
  const tail = appendTail(null, ev(5), AI_CACHE_MAX_BYTES);
  assert.deepEqual(tail.events.map((e) => e.seq), [5]);
});

test("appendTail drops from the head to stay under the cap", () => {
  const events = Array.from({ length: 4 }, (_, i) => ev(i + 1, "q".repeat(40)));
  const cap = eventBytes(events[0]) * 3;
  let tail = null;
  for (const e of events) tail = appendTail(tail, e, cap);
  assert.deepEqual(tail.events.map((e) => e.seq), [2, 3, 4]);
  assert.ok(tail.bytes <= cap);
  assert.equal(tail.dropped, true, "the cache knows it is no longer the whole log");
});

test("appendTail reuses the tail's byte count instead of re-measuring it", () => {
  const first = ev(1, "a");
  const tail = appendTail({ events: [first], bytes: eventBytes(first) }, ev(2, "b"), AI_CACHE_MAX_BYTES);
  assert.equal(tail.bytes, eventBytes(first) + eventBytes(ev(2, "b")));
  assert.equal(tail.dropped, false);
});

test("appendTail reports no drop while everything still fits", () => {
  const tail = appendTail(null, ev(1), AI_CACHE_MAX_BYTES);
  assert.equal(tail.dropped, false);
});

test("buildCacheEntry derives seq from the tail and stamps the schema", () => {
  const entry = buildCacheEntry({
    hostKey: "h1", sessionId: "s1", epoch: 7,
    tail: trimTail([ev(1), ev(2)], 1000),
    taskRecords: [["task", "run", { id: "t" }, 0]],
    lastTurnMs: 42, now: 1000
  });
  assert.equal(entry.v, AI_CACHE_SCHEMA);
  assert.equal(entry.seq, 2);
  assert.equal(entry.firstSeq, 1);
  assert.equal(entry.epoch, 7);
  assert.equal(entry.ts, 1000);
  assert.equal(entry.lastTurnMs, 42);
  assert.equal(entry.events.length, 2);
});

test("buildCacheEntry refuses an empty tail or a missing generation", () => {
  assert.equal(buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail: trimTail([], 10) }), null);
  assert.equal(buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: null, tail: trimTail([ev(1)], 10) }), null);
  assert.equal(buildCacheEntry({ hostKey: "h", sessionId: "", epoch: 7, tail: trimTail([ev(1)], 10) }), null);
});

test("parseCacheEntry accepts JSON or an object and rejects bad shapes", () => {
  const good = buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail: trimTail([ev(1)], 1000), now: 5 });
  assert.deepEqual(parseCacheEntry(JSON.stringify(good)), good);
  assert.deepEqual(parseCacheEntry(good), good);
  assert.equal(parseCacheEntry(null), null);
  assert.equal(parseCacheEntry("not json"), null);
  assert.equal(parseCacheEntry({ ...good, v: AI_CACHE_SCHEMA + 1 }), null, "wrong schema");
  assert.equal(parseCacheEntry({ ...good, events: "nope" }), null);
  assert.equal(parseCacheEntry({ ...good, epoch: "7" }), null, "epoch must be a number");
  assert.equal(parseCacheEntry({ ...good, seq: 0 }), null, "a cache with no seq is useless");
});

test("a cached tail is trusted for one day, not longer", () => {
  assert.equal(AI_CACHE_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test("shouldUseCachedSnapshot accepts a fresh matching entry", () => {
  const entry = buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail: trimTail([ev(1)], 1000), now: 1000 });
  assert.equal(shouldUseCachedSnapshot(entry, { hostKey: "h", sessionId: "s", now: 2000 }), true);
});

test("shouldUseCachedSnapshot rejects another host, session, schema or an old entry", () => {
  const entry = buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail: trimTail([ev(1)], 1000), now: 1000 });
  assert.equal(shouldUseCachedSnapshot(entry, { hostKey: "other", sessionId: "s", now: 2000 }), false);
  assert.equal(shouldUseCachedSnapshot(entry, { hostKey: "h", sessionId: "other", now: 2000 }), false);
  assert.equal(shouldUseCachedSnapshot(entry, { hostKey: "h", sessionId: "s", now: 1000 + AI_CACHE_MAX_AGE_MS + 1 }), false);
  assert.equal(shouldUseCachedSnapshot(null, { hostKey: "h", sessionId: "s", now: 2000 }), false);
  assert.equal(shouldUseCachedSnapshot({ ...entry, v: 99 }, { hostKey: "h", sessionId: "s", now: 2000 }), false);
});

test("shouldUseCachedSnapshot rejects an entry whose first seq does not match its events", () => {
  const entry = buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail: trimTail([ev(3)], 1000), now: 1000 });
  assert.equal(shouldUseCachedSnapshot({ ...entry, firstSeq: 99 }, { hostKey: "h", sessionId: "s", now: 1000 }), false);
  assert.equal(shouldUseCachedSnapshot({ ...entry, seq: 1 }, { hostKey: "h", sessionId: "s", now: 1000 }), false);
});

test("buildCacheEntry carries the tail's byte count so pruning can budget it", () => {
  const tail = trimTail([ev(1), ev(2)], 1000);
  const entry = buildCacheEntry({ hostKey: "h", sessionId: "s", epoch: 7, tail, now: 1 });
  assert.equal(entry.bytes, tail.bytes);
});

test("selectPrunable keeps the newest entries under the count cap", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, ts: i, bytes: 10 }));
  const drop = selectPrunable(rows, { maxEntries: 3, maxBytes: 1000 });
  assert.deepEqual(drop, ["k0", "k1"]);
});

test("selectPrunable enforces the total byte budget", () => {
  const rows = [
    { key: "old", ts: 1, bytes: 400 },
    { key: "mid", ts: 2, bytes: 400 },
    { key: "new", ts: 3, bytes: 400 }
  ];
  const drop = selectPrunable(rows, { maxEntries: 30, maxBytes: 900 });
  assert.deepEqual(drop, ["old"], "the oldest pays for the budget");
});

test("selectPrunable never drops the newest entry to make room", () => {
  const rows = [{ key: "solo", ts: 1, bytes: 5_000_000 }];
  assert.deepEqual(selectPrunable(rows, { maxEntries: 30, maxBytes: 1000 }), [], "an oversized entry stays until the next write");
});

test("selectPrunable assumes the per-entry cap when the byte count is missing", () => {
  const rows = [{ key: "legacy", ts: 1 }, { key: "new", ts: 2, bytes: 1 }];
  const drop = selectPrunable(rows, { maxEntries: 30, maxBytes: 1000 });
  assert.deepEqual(drop, ["legacy"], "unknown size is treated as worst-case, not as free");
});

test("selectPrunable on an empty list drops nothing", () => {
  assert.deepEqual(selectPrunable([], { maxEntries: 3, maxBytes: 10 }), []);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
