// Deterministic test: does bash emit OSC 7 + does daemon regex parse cwd correctly?
// Run: node agent/test/osc7-cwd.test.mjs
import pty from "node-pty";
import os from "os";

const OSC_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/;

function spawnShell(opts = {}) {
  const env = { ...process.env, ...opts.env };
  return pty.spawn(process.env.SHELL || "/bin/bash", opts.args || ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env,
    useConpty: false,
  });
}

function collectCwd(shell, { feed, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let buf = "";
    const cwdValues = new Set();
    const timer = setTimeout(() => {
      shell.kill();
      resolve({ buf, cwdValues: [...cwdValues] });
    }, timeout);
    shell.onData((d) => {
      buf += d;
      const m = d.match(OSC_RE);
      if (m) {
        let v = m[1];
        try { v = decodeURIComponent(v); } catch {}
        cwdValues.add(v);
      }
    });
    if (feed) {
      // Wait briefly for shell init, then feed commands
      setTimeout(() => {
        for (const line of feed) shell.write(line + "\r");
      }, 500);
    }
    shell.onExit(() => { clearTimeout(timer); resolve({ buf, cwdValues: [...cwdValues] }); });
  });
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log("Test 1: bash emits OSC 7 with cwd when PROMPT_COMMAND injected");
{
  const { cwdValues } = await collectCwd(spawnShell({
    env: { PROMPT_COMMAND: 'printf "\\033]7;file://${HOSTNAME}${PWD}\\a"' },
  }), { feed: ["cd /tmp", "echo MARKER_DONE"], timeout: 2500 });

  console.log("  cwdValues captured:", cwdValues);
  assert(cwdValues.length > 0, "shell emitted at least one OSC 7 cwd");
  assert(cwdValues.some((v) => v.endsWith("/tmp")), `cwd updated to /tmp after cd (got: ${cwdValues.join(", ")})`);
}

console.log("\nTest 2: regex extracts path from raw OSC 7 byte stream");
{
  const samples = [
    { raw: "\x1b]7;file://host/Users/foo\x07", expect: "/Users/foo" },
    { raw: "\x1b]7;file://host/tmp\x1b\\", expect: "/tmp" }, // ST terminator
    { raw: "\x1b]7;file://host/Users/a%20b\x07", expect: "/Users/a b" }, // encoded space
  ];
  for (const { raw, expect } of samples) {
    const m = raw.match(OSC_RE);
    let got = m?.[1];
    try { got = decodeURIComponent(got); } catch {}
    assert(got === expect, `parse "${expect}" (got "${got}")`);
  }
}

console.log("\nTest 3: login shell (-l) — does it preserve injected PROMPT_COMMAND?");
{
  const { cwdValues } = await collectCwd(spawnShell({
    args: ["-l"],
    env: { PROMPT_COMMAND: 'printf "\\033]7;file://${HOSTNAME}${PWD}\\a"' },
  }), { feed: ["cd /tmp"], timeout: 2500 });

  console.log("  login-shell cwdValues:", cwdValues);
  if (cwdValues.length === 0) {
    console.log("  ⚠️  login shell did NOT emit OSC — .bash_profile/.bash_profile may override PROMPT_COMMAND.");
    console.log("      Fix: inject OSC via a different mechanism, or drop -l, or append in rc.");
  }
  assert(cwdValues.length > 0, "login shell preserves PROMPT_COMMAND inject");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
