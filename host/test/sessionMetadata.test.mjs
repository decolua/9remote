// Tests for buildSessionMetadata — R1 v2 persists last client size to sessions.json
// so a respawned PTY after an agent restart inherits the real terminal size.
// Run: node agent/test/sessionMetadata.test.mjs
import assert from "node:assert/strict";
import { buildSessionMetadata } from "../features/terminal/ptyHelper.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("serializes core fields (name/createdAt/shellId/cwd)", () => {
  const m = buildSessionMetadata({ name: "Term 1", createdAt: 123, shellId: "zsh", cwd: "/home" });
  assert.deepEqual(m, {
    name: "Term 1", autoNamed: true, createdAt: 123, shellId: "zsh", cwd: "/home",
    workspacePath: null, cols: null, rows: null,
    // Which CLI runs in the terminal, null when none does (or none was detected).
    agent: null
  });
});

test("who owns the name survives a restart", () => {
  // An auto-named terminal follows its conversation's title; one the user named
  // must not, and a restart that forgot which was which would rename it for them.
  assert.equal(buildSessionMetadata({ name: "T", autoNamed: false }).autoNamed, false);
  assert.equal(buildSessionMetadata({ name: "T", autoNamed: true }).autoNamed, true);
  // Written before the flag existed: absence is not the user having named it.
  assert.equal(buildSessionMetadata({ name: "Term 3" }).autoNamed, true);
});

test("workspacePath survives a restart, and is not the live cwd", () => {
  const m = buildSessionMetadata({ name: "T", createdAt: 1, cwd: "/repo/web", workspacePath: "/repo" });
  assert.equal(m.workspacePath, "/repo", "the workspace root is fixed at creation");
  assert.equal(m.cwd, "/repo/web", "cwd still tracks where the user actually is");
});

test("persists lastCols/lastRows when present (resize tracked them)", () => {
  const m = buildSessionMetadata({ name: "T", createdAt: 1, shellId: "bash", cwd: "/", lastCols: 132, lastRows: 50 });
  assert.equal(m.cols, 132);
  assert.equal(m.rows, 50);
});

test("cols/rows null when no tracked size (fresh session before first resize)", () => {
  const m = buildSessionMetadata({ name: "T", createdAt: 1, shellId: "bash", cwd: "/" });
  assert.equal(m.cols, null);
  assert.equal(m.rows, null);
});

test("lastCols/lastRows take precedence over legacy cols/rows", () => {
  const m = buildSessionMetadata({ name: "T", createdAt: 1, shellId: "bash", cwd: "/", cols: 80, rows: 24, lastCols: 100, lastRows: 30 });
  assert.equal(m.cols, 100);
  assert.equal(m.rows, 30);
});

test("nullish lastCols falls through to cols then null", () => {
  const m = buildSessionMetadata({ name: "T", createdAt: 1, shellId: "bash", cwd: "/", cols: 80 });
  assert.equal(m.cols, 80);
  assert.equal(m.rows, null);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
