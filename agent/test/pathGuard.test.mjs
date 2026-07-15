// Security regression tests for pathGuard + GitHandler no-shell git.
// Real fs + real git — NO mocks. Run: node agent/test/pathGuard.test.mjs
//
// Covers:
//  - Vuln 10: symlink escape via realpath fallback (pathGuard.canonicalize)
//  - Vuln 1:  shell injection in git commands (GitHandler.runGit must spawn no-shell)
//  - Baseline: benign workspace paths must NOT be blocked (no feature break)
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { isSensitivePath } from "../features/fileExplorer/pathGuard.js";
import { runGit, runGitSync } from "../features/fileExplorer/handlers/GitHandler.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  const r = fn();
  if (r && typeof r.then === "function") {
    return r.then(() => { pass++; console.log(`  ✓ ${name}`); })
      .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
  }
  pass++; console.log(`  ✓ ${name}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "9r-sec-"));
const HOME = os.homedir();
const pwnMarker = path.join(TMP, "pwned_9r");

console.log(`\nSuite 1: isSensitivePath baseline (must NOT break workspace explore)`);

await test("benign workspace file is allowed", () => {
  const f = path.join(TMP, "main.js");
  fs.writeFileSync(f, "x");
  assert.equal(isSensitivePath(f), false);
});

await test("benign nested dir is allowed", () => {
  const d = path.join(TMP, "src", "lib");
  fs.mkdirSync(d, { recursive: true });
  assert.equal(isSensitivePath(d), false);
});

await test("~/.ssh is blocked (existing sensitive dir)", () => {
  assert.equal(isSensitivePath(path.join(HOME, ".ssh")), true);
});

await test("~/.ssh/config blocked even if not yet existing", () => {
  const p = path.join(HOME, ".ssh", "definitely_not_existing_config");
  assert.ok(!fs.existsSync(p), "precondition: target absent");
  assert.equal(isSensitivePath(p), true);
});

console.log(`\nSuite 2: Vuln 10 — symlink escape via realpath fallback`);

await test("symlink to ~/.ssh is blocked (existing target)", () => {
  const link = path.join(TMP, "escape_existing");
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(path.join(HOME, ".ssh"), link);
  assert.equal(isSensitivePath(link), true);
});

await test("symlink escape to ~/.ssh/non-existent is blocked (the bug)", () => {
  // The bug: realpathSync throws (target file absent) -> path.resolve (lexical) -> escape.
  // Fix: resolve realpath of nearest existing ancestor then re-append remainder.
  const link = path.join(TMP, "escape_dir");
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(path.join(HOME, ".ssh"), link);
  const target = path.join(link, "new_key_file"); // does not exist
  assert.ok(!fs.existsSync(target), "precondition: target absent");
  assert.equal(isSensitivePath(target), true, "symlinked non-existent path must resolve through link");
});

await test("normal non-sensitive symlink is allowed", () => {
  const real = path.join(TMP, "real_subdir");
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(TMP, "link_subdir");
  try { fs.unlinkSync(link); } catch {}
  fs.symlinkSync(real, link);
  assert.equal(isSensitivePath(path.join(link, "file.js")), false);
});

console.log(`\nSuite 3: Vuln 1 — git commands must not spawn a shell`);

await test("runGit is async (returns Promise)", () => {
  const r = runGit(["--version"], TMP);
  assert.equal(typeof r.then, "function", "runGit must return a Promise");
  return r;
});

await test("runGit --version succeeds", async () => {
  const r = await runGit(["--version"], TMP);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /git version/);
});

await test("runGitSync (sync no-shell) returns stdout, no injection", async () => {
  // The 3 converted handlers use runGitSync. Verify it returns plain stdout and a
  // metachar path is passed as one argv element (no shell eval).
  const repo = path.join(TMP, "repo_sync");
  fs.mkdirSync(repo, { recursive: true });
  await runGit(["init"], repo);
  const probe = "pwned9r_sync";
  const probePath = path.join(repo, probe);
  if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
  const name = "a$(touch " + probe + ")b.js";
  fs.writeFileSync(path.join(repo, name), "x");
  const out = runGitSync(["status", "--porcelain", "--", name], repo);
  assert.ok(!fs.existsSync(probePath), "runGitSync must not eval shell");
  assert.ok(out.includes(name), "returns real status with the weird-named file");
});

await test("no shell injection via filename containing shell metachars", async () => {
  // Init a real repo, add a file with a shell-injection payload as its NAME.
  // A literal $() is rejected by most filesystems, so use a quote/backtick/semicolon
  // payload that IS a valid filename but would break out of execSync(`git add -- "${file}"`).
  // spawn("git",[...],{shell:false}) must NOT eval any of it.
  const repo = path.join(TMP, "repo_inj");
  fs.mkdirSync(repo, { recursive: true });
  const init = await runGit(["init"], repo);
  assert.equal(init.code, 0, "git init ok");

  if (fs.existsSync(pwnMarker)) fs.unlinkSync(pwnMarker);
  // Backtick + $() are filesystem-legal but command-substitution in a shell double-quote.
  // `git add -- "${file}"` with file = `a` + $(cmd) + `b.js` would let the shell eval cmd.
  // cmd must produce no '/' (path-sep is illegal in filenames), so it touches a marker
  // in the repo CWD via a plain name.
  const probe = "pwned9r";
  const probePath = path.join(repo, probe);
  if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
  const payload = "a$(touch " + probe + ")b.js";
  fs.writeFileSync(path.join(repo, payload), "x");

  const add = await runGit(["add", "--", payload], repo);
  assert.ok(!fs.existsSync(probePath), "shell injection must NOT execute (touch)");
  assert.equal(add.code, 0, "git add of metachar-named file succeeds");
});

await test("git add -- path with shell metachars adds the real file (no RCE)", async () => {
  const repo = path.join(TMP, "repo_inj2");
  fs.mkdirSync(repo, { recursive: true });
  await runGit(["init"], repo);
  const name = 'x";id;echo "y';
  fs.writeFileSync(path.join(repo, name), "x");
  if (fs.existsSync(pwnMarker)) fs.unlinkSync(pwnMarker);
  const add = await runGit(["add", "--", name], repo);
  assert.ok(!fs.existsSync(pwnMarker), "no shell eval from quoted metachar name");
  const status = await runGit(["status", "--porcelain"], repo);
  assert.ok(status.stdout.includes("A"), "file actually staged");
});

// cleanup
try {
  for (const e of fs.readdirSync(TMP)) {
    const full = path.join(TMP, e);
    try { fs.rmSync(full, { recursive: true }); } catch {}
  }
  fs.rmdirSync(TMP);
} catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
