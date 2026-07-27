// Verify PowerShell OSC 7 prompt injection: stdin-write echoes the command (bug),
// while -Command arg does not (fix). Run: node agent/scripts/test-ps-osc7.mjs
import { spawn } from "node:child_process";
import { psOsc7PromptCommand, buildShellArgs } from "../features/terminal/constants.js";

const PWSH = process.env.PWSH_PATH || "pwsh";
const PROMPT_FN = psOsc7PromptCommand();

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "  PASS" : "  FAIL"} — ${msg}`);
  cond ? pass++ : fail++;
};

// Collect all output (stdout+stderr) of a child process until it exits.
function collect(child) {
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out));
  });
}

// Case A — reproduce the bug: write setup via stdin after spawn.
// PSReadLine echoes stdin input, so the `function prompt {...}` line shows up.
async function testStdinEcho() {
  console.log("\n[A] stdin write (legacy approach — expect ECHO of command)");
  const child = spawn(PWSH, ["-NoLogo"], { stdio: ["pipe", "pipe", "pipe"] });
  setTimeout(() => {
    try { child.stdin.write(PROMPT_FN + "\r\n"); } catch {}
    setTimeout(() => {
      try { child.stdin.write("exit\r\n"); } catch {}
    }, 300);
  }, 200);
  const out = await collect(child);
  // The echoed source contains the literal `function prompt` token.
  assert(out.includes("function prompt"), "stdin write echoes `function prompt` to screen");
}

// Case B — verify the fix: pass setup via -NoExit -Command arg.
// PowerShell runs it before entering the REPL; PSReadLine never echoes it.
async function testArgNoEcho() {
  console.log("\n[B] -NoExit -Command arg (fix — expect NO echo)");
  const child = spawn(PWSH, ["-NoLogo", "-NoExit", "-Command", PROMPT_FN], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  setTimeout(() => {
    try { child.stdin.write("exit\r\n"); } catch {}
  }, 400);
  const out = await collect(child);
  assert(!out.includes("function prompt"), "arg approach does NOT echo `function prompt`");
}

// Case C — OSC 7 actually emitted after the fix (prompt function is active).
// `prompt` runs each render; output must contain the OSC 7 sequence ]7;file://.
async function testOsc7Emitted() {
  console.log("\n[C] OSC 7 sequence emitted under arg approach (prompt is active)");
  const child = spawn(PWSH, ["-NoLogo", "-NoExit", "-Command", PROMPT_FN], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  setTimeout(() => {
    try { child.stdin.write("\r\nexit\r\n"); } catch {}  // force a prompt render, then exit
  }, 400);
  const out = await collect(child);
  assert(out.includes("]7;file://"), "OSC 7 (]7;file://) present in output");
}

// Case D — unit: buildShellArgs injects -NoExit -Command for PS, leaves others untouched.
function testBuildArgs() {
  console.log("\n[D] buildShellArgs (unit)");
  const ps = buildShellArgs({ id: "pwsh", args: ["-NoLogo"] });
  assert(JSON.stringify(ps) === JSON.stringify(["-NoLogo", "-NoExit", "-Command", PROMPT_FN]),
    "pwsh args = [-NoLogo, -NoExit, -Command, <promptFn>]");
  const cmd = buildShellArgs({ id: "cmd", args: [] });
  assert(JSON.stringify(cmd) === JSON.stringify([]), "cmd args untouched (uses PROMPT env)");
}

(async () => {
  console.log(`pwsh: ${PWSH}`);
  await testStdinEcho();
  await testArgNoEcho();
  await testOsc7Emitted();
  testBuildArgs();
  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
