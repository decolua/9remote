// EPIPE from a parent-closed stdout pipe must never kill the CLI (#47/#50):
// the QR/banner console.log right after tunnel-ready crashed the whole server on
// Windows when the launcher (Tauri/desktop) stopped reading the pipe. Node ignores
// SIGPIPE but surfaces the write failure as an async 'error' event on the stream —
// with no listener it becomes a fatal uncaughtException.
// Run: node test/epipeGuard.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = pathToFileURL(path.join(ROOT, "lib", "stdioGuard.js")).href;

// Spawn with piped stdout, then close the parent's read end immediately — the
// child boots slower than this destroy, so every child write hits a dead pipe.
const runWithClosedPipe = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.destroy();
  child.stderr.destroy();
  child.on("error", () => resolve(-1));
  child.on("exit", (code) => resolve(code ?? -1));
});

// Same driver both ways: keep writing for 500ms, then exit 42 — surviving the
// dead pipe long enough to prove the async EPIPE had time to land.
const driver = (importGuard) => `
  ${importGuard ? `await import(${JSON.stringify(GUARD)});` : ""}
  process.stdout.write("start\\n");
  const t = setInterval(() => process.stdout.write("tick\\n"), 20);
  setTimeout(() => { clearInterval(t); process.exit(42); }, 500);
`;

await test("harness sanity: bare process writing to a closed pipe dies (EPIPE is real here)", async () => {
  const code = await runWithClosedPipe(["-e", driver(false)]);
  assert.notEqual(code, 0, "expected a crash from the unguarded dead-pipe writes");
});

await test("stdioGuard keeps a writing process alive across a dead pipe (guard module)", async () => {
  const code = await runWithClosedPipe(["-e", driver(true)]);
  assert.equal(code, 42, "expected clean exit 42 with the guard installed");
});

// Regression wiring: the real CLI entry must install the guard before its first
// stdout write. May not have been red pre-fix (fast exit can truncate the error),
// so the pair above carries the behavioral proof.
await test("CLI `version` exits 0 even when its stdout pipe is already closed", async () => {
  const code = await runWithClosedPipe([path.join(ROOT, "cli", "index.js"), "version"]);
  assert.equal(code, 0, `expected exit 0, got ${code}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
