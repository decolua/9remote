// Tests for PTY respawn size resolution.
// R1: when a daemon session is recreated (needsRespawn / lost session), the new PTY
// must spawn at the client's real measured size. The size comes from the joinSession
// payload (live) first, then from persisted metadata (lastCols/lastRows), and only
// falls back to 80×24 for legacy clients that send a bare sessionId.
//
// Run: node agent/test/respawnSize.test.mjs
import assert from "node:assert/strict";
import { pickRespawnSize } from "../features/terminal/handlers/SessionHandler.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("uses join/metadata size when present", () => {
  assert.deepEqual(pickRespawnSize({ lastCols: 120, lastRows: 40 }), { cols: 120, rows: 40 });
});

test("uses join/metadata size even if only cols differs", () => {
  assert.deepEqual(pickRespawnSize({ lastCols: 200, lastRows: 24 }), { cols: 200, rows: 24 });
});

test("falls back to 80×24 only when no size known (legacy client, fresh session)", () => {
  assert.deepEqual(pickRespawnSize({}), { cols: 80, rows: 24 });
});

test("falls back when size below sane floor (transient tiny size)", () => {
  assert.deepEqual(pickRespawnSize({ lastCols: 5, lastRows: 1 }), { cols: 80, rows: 24 });
});

test("falls back when only one dimension known", () => {
  assert.deepEqual(pickRespawnSize({ lastCols: 100 }), { cols: 80, rows: 24 });
  assert.deepEqual(pickRespawnSize({ lastRows: 30 }), { cols: 80, rows: 24 });
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
