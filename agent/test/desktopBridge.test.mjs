// Unit tests for desktopBridge PowerShell command generation (ad-hoc launcher
// pattern — no scheduled task, no .ps1 file; matches .docs/login/unlock.cjs).
// Pure string checks — no Windows, no spawn, no UAC.
// Run: node agent/test/desktopBridge.test.mjs
import assert from "node:assert/strict";
import { _escapePs, _buildElevateCmd } from "../lib/desktopBridge.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  PASS" : "  FAIL"} — ${msg}`);
  cond ? pass++ : fail++;
};
const includes = (hay, needle, msg) => ok(hay.includes(needle), `${msg} (expected "${needle}")`);

// --- _escapePs: PowerShell single-quote escaping ---
console.log("\n[_escapePs]");
ok(_escapePs("abc") === "abc", "no quotes → unchanged");
ok(_escapePs("a'b") === "a''b", "one quote → doubled");
ok(_escapePs("a''b") === "a''''b", "two quotes → quadrupled");
ok(_escapePs("") === "", "empty → empty");
ok(_escapePs("C:\\path\\exe") === "C:\\path\\exe", "backslashes untouched (PS single-quote verbatim)");

// --- _buildElevateCmd: Start-Process launcher.exe -Verb RunAs ---
// Ad-hoc UAC: the launcher (elevated, console session) spawns the worker into
// the console session. No -Command script, no .ps1 file, no scheduled task —
// that was the bug that put the worker in session 0 where SendInput missed
// the user's Winlogon desktop.
console.log("\n[_buildElevateCmd]");
{
  const cmd = _buildElevateCmd("C:\\Users\\me\\.9remote\\bin\\desktop-elevate.exe");
  includes(cmd, "Start-Process", "uses Start-Process");
  includes(cmd, "-FilePath", "explicit -FilePath (not positional collision)");
  includes(cmd, "'C:\\Users\\me\\.9remote\\bin\\desktop-elevate.exe'", "embeds launcher path");
  includes(cmd, "-Verb RunAs", "elevates via RunAs (UAC prompt)");
  ok(!cmd.includes("'-Command'"), "does NOT inline -Command");
  ok(!cmd.includes("-File "), "does NOT use -File script");
  ok(!/Register-ScheduledTask|schtasks|New-ScheduledTask/i.test(cmd), "no scheduled task (session 0 footgun)");
}
{
  const cmd = _buildElevateCmd("C:\\a'b\\exe.exe");
  includes(cmd, "'C:\\a''b\\exe.exe'", "launcher path quote escaped");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
