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
  const cmd = _buildElevateCmd("C:\\Users\\me\\.9remote\\bin\\desktop-elevate.exe", "9remote-unlock");
  includes(cmd, "Start-Process", "uses Start-Process");
  includes(cmd, "-Verb RunAs", "elevates via RunAs (UAC prompt)");
  includes(cmd, "-Wait", "waits for the elevated child");
  includes(cmd, "New-ScheduledTaskAction -Execute", "action runs launcher");
  includes(cmd, "desktop-elevate.exe", "action targets the launcher exe");
  includes(cmd, "New-ScheduledTaskTrigger -AtLogon", "triggers at logon (not AtStartup → session 0)");
  includes(cmd, "Register-ScheduledTask -TaskName", "registers task");
  includes(cmd, "9remote-unlock", "task name present");
  includes(cmd, "-RunLevel Highest", "elevated task (launcher can impersonate SYSTEM)");
  includes(cmd, "Start-ScheduledTask -TaskName", "starts task immediately");
  // No session-0 footgun: AtStartup + SYSTEM principal would run the worker in
  // session 0 where SendInput misses the user's Winlogon desktop.
  ok(!/AtStartup|UserId.*SYSTEM|-Principal /i.test(cmd), "no AtStartup/SYSTEM (session 0)");
  // No quoting-hell / .ps1 / -FilePath-collision regressions.
  ok(!cmd.includes("-FilePath "), "does NOT use -FilePath (positional collision)");
}
// Quote in launcher path / task name is escaped (doubled inside the -Command arg).
{
  const cmd = _buildElevateCmd("C:\\a'b\\exe.exe", "ta'sk");
  includes(cmd, "C:\\a''b\\exe.exe", "launcher path quote doubled");
  includes(cmd, "ta''sk", "task name quote doubled");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
