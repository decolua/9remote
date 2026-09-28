// Unit tests for desktopBridge: PowerShell command generation + the pure
// decision helpers that gate the UAC prompt and the rebuild.
//
// Design under test — boot persistence via an AtStartup SYSTEM scheduled task
// running desktop-elevate.exe, which duplicates the console-session winlogon
// token so the worker lands on the user's Winlogon desktop. UAC is asked ONLY
// when the user toggles On/Off, never at agent startup.
// Pure string/branch checks — no Windows, no spawn, no UAC.
// Run: node agent/test/desktopBridge.test.mjs
import {
  _escapePs,
  _buildInstallTaskCmd,
  _buildDeleteTaskCmd,
  _shouldElevate,
  _parseVersion,
  _exeNameFor,
  _pickNewestExe,
  _isWorkerStale,
  TASK_NAME
} from "../lib/desktopBridge.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  PASS" : "  FAIL"} — ${msg}`);
  cond ? pass++ : fail++;
};
const includes = (hay, needle, msg) => ok(hay.includes(needle), `${msg} (expected "${needle}")`);
const excludes = (hay, needle, msg) => ok(!hay.includes(needle), `${msg} (must not contain "${needle}")`);

// --- _escapePs: PowerShell single-quote escaping ---
console.log("\n[_escapePs]");
ok(_escapePs("abc") === "abc", "no quotes → unchanged");
ok(_escapePs("a'b") === "a''b", "one quote → doubled");
ok(_escapePs("a''b") === "a''''b", "two quotes → quadrupled");
ok(_escapePs("") === "", "empty → empty");
ok(_escapePs("C:\\path\\exe") === "C:\\path\\exe", "backslashes untouched (PS single-quote verbatim)");

// --- _buildInstallTaskCmd ---
// The task must fire at BOOT as SYSTEM. -AtLogon is wrong here: a rebooted
// machine sits at the lock screen with nobody logged on, so a logon trigger
// would never fire — exactly the case remote unlock exists for.
console.log("\n[_buildInstallTaskCmd]");
{
  const cmd = _buildInstallTaskCmd("C:\\Users\\me\\.9remote\\bin\\desktop-elevate.exe", TASK_NAME);
  includes(cmd, "-Verb RunAs", "outer wrapper elevates via UAC");
  includes(cmd, "-Wait", "waits so the caller knows when registration finished");
  includes(cmd, "New-ScheduledTaskAction", "registers a scheduled task");
  includes(cmd, "-AtStartup", "boot trigger (survives reboot with nobody logged on)");
  excludes(cmd, "-AtLogon", "NOT a logon trigger (never fires at a locked boot screen)");
  includes(cmd, "New-ScheduledTaskPrincipal", "explicit principal");
  // Quotes appear doubled: the inner script is escaped once when embedded into
  // the outer -Command argument, so PowerShell sees '...' after unwrapping.
  includes(cmd, "-UserId ''SYSTEM''", "runs as SYSTEM (no user session needed at boot)");
  includes(cmd, "-LogonType ServiceAccount", "service-account logon type for SYSTEM");
  includes(cmd, "-RunLevel Highest", "highest run level");
  includes(cmd, "-Force", "re-register overwrites an existing task");
  includes(cmd, "Start-ScheduledTask", "starts the task now (worker up without a reboot)");
  includes(cmd, "ExecutionTimeLimit", "no execution time limit — worker is a daemon");
  includes(cmd, `-TaskName ''${TASK_NAME}''`, "task name embedded");
  includes(cmd, "desktop-elevate.exe", "launcher path embedded");
  includes(cmd, "-Execute ", "-Execute takes the path natively (no cmdline quoting)");
  excludes(cmd, "schtasks", "no schtasks /TR cmdline (quoting hell with spaces in path)");
  const spaced = _buildInstallTaskCmd("C:\\Users\\Test User\\.9remote\\bin\\desktop-elevate.exe", TASK_NAME);
  includes(spaced, "'C:\\Users\\Test User\\.9remote\\bin\\desktop-elevate.exe'", "space in path stays in one quoted token");
}
{
  // Double escaping: a literal quote is escaped once for the inner script, then
  // again when that script is embedded in the outer -Command argument.
  const cmd = _buildInstallTaskCmd("C:\\a'b\\exe.exe", TASK_NAME);
  includes(cmd, "C:\\a''''b\\exe.exe", "quote in path escaped twice (inner + outer nesting)");
}

// --- _buildDeleteTaskCmd ---
console.log("\n[_buildDeleteTaskCmd]");
{
  const cmd = _buildDeleteTaskCmd(TASK_NAME);
  includes(cmd, "-Verb RunAs", "elevates via UAC");
  includes(cmd, "Unregister-ScheduledTask", "removes the task");
  includes(cmd, `-TaskName ''${TASK_NAME}''`, "task name embedded");
  includes(cmd, "-Confirm:$false", "no interactive confirm");
  includes(cmd, "SilentlyContinue", "missing task is not an error");
  ok(_buildDeleteTaskCmd("a'b").includes("a''''b"), "quote in task name escaped twice");
}

// --- _shouldElevate: the ONLY gate for a UAC prompt ---
// Toggling On is the sole caller of install(); agent startup never calls it.
// Inside install(), prompt only when something actually needs admin.
console.log("\n[_shouldElevate]");
ok(_shouldElevate({ alive: true,  hasTask: true  }) === false, "worker up + task registered → no prompt (idempotent re-toggle)");
ok(_shouldElevate({ alive: false, hasTask: true  }) === true,  "task exists but worker down → prompt to start it");
ok(_shouldElevate({ alive: true,  hasTask: false }) === true,  "worker up but no boot task → prompt to register (else reboot loses it)");
ok(_shouldElevate({ alive: false, hasTask: false }) === true,  "first install → prompt");

// --- _parseVersion: read the declared VERSION out of the shipped .cs ---
// mtime comparison was the old gate and it was wrong: copyFileSync restamps the
// copy, npm unpack order is not guaranteed, clocks skew. An explicit constant in
// the source is the same contract as DAEMON_VERSION for the pty daemon — bump it
// when the .cs changes.
console.log("\n[_parseVersion]");
ok(_parseVersion(`const string VERSION = "7";`) === "7", "reads a plain declaration");
ok(_parseVersion(`  static const string VERSION  =  "12" ;`) === "12", "tolerates extra spacing/modifiers");
ok(_parseVersion(`class X {\n  const string VERSION = "3";\n  int a;\n}`) === "3", "finds it inside a class body");
ok(_parseVersion(`const string OTHER = "9";`) === null, "unrelated constant → null");
ok(_parseVersion("") === null, "empty source → null");
ok(_parseVersion(null) === null, "missing source → null (never throws)");

// --- _exeNameFor: version-stamped binary name ---
// The whole point: build a NEW file instead of overwriting the running one.
// Overwriting is what forced a STOP (and a UAC prompt) before every rebuild,
// and what made csc fail with CS0016 when the worker held the lock.
console.log("\n[_exeNameFor]");
ok(_exeNameFor("1") === "desktop-bridge-1.exe", "stamps the version into the filename");
ok(_exeNameFor("12") === "desktop-bridge-12.exe", "multi-digit version");
ok(_exeNameFor("1") !== "desktop-bridge.exe", "never the legacy unversioned name (that one gets locked)");

// --- _pickNewestExe: launcher-side selection ---
// Numeric ordering, not lexicographic: "10" must beat "9". String sort would
// pick 9 and silently keep running the old worker forever.
console.log("\n[_pickNewestExe]");
ok(_pickNewestExe(["desktop-bridge-1.exe", "desktop-bridge-2.exe"]) === "desktop-bridge-2.exe", "picks the higher version");
ok(_pickNewestExe(["desktop-bridge-9.exe", "desktop-bridge-10.exe"]) === "desktop-bridge-10.exe", "numeric compare (10 > 9, not lexicographic)");
ok(_pickNewestExe(["desktop-bridge-2.exe", "desktop-bridge-1.exe"]) === "desktop-bridge-2.exe", "order-independent");
ok(_pickNewestExe(["desktop-bridge-3.exe"]) === "desktop-bridge-3.exe", "single candidate");
ok(_pickNewestExe([]) === null, "no candidates → null");
ok(_pickNewestExe(["desktop-elevate.exe", "readme.txt"]) === null, "ignores unrelated files");
ok(_pickNewestExe(["desktop-bridge.exe", "desktop-bridge-2.exe"]) === "desktop-bridge-2.exe", "legacy unversioned exe never wins");

// --- _isWorkerStale: has the worker fallen behind the shipped source? ---
// A worker predating this scheme answers "ERR unknown" to VERSION → null → stale.
console.log("\n[_isWorkerStale]");
ok(_isWorkerStale({ workerVersion: "1", sourceVersion: "1" }) === false, "same version → current");
ok(_isWorkerStale({ workerVersion: "1", sourceVersion: "2" }) === true,  "source ahead → stale");
ok(_isWorkerStale({ workerVersion: null, sourceVersion: "2" }) === true, "legacy worker (no VERSION cmd) → stale");
ok(_isWorkerStale({ workerVersion: "2", sourceVersion: null }) === false, "unreadable source → not stale (never churn on a bad read)");
ok(_isWorkerStale({ workerVersion: "3", sourceVersion: "2" }) === false, "worker ahead of source → not stale (downgrade is not an update)");
// A probe can time out while the worker is mid-TYPE: the pipe is single-threaded,
// so typing a long password blocks VERSION for seconds. That is an UNKNOWN answer,
// not an old worker — treating it as stale would stop a perfectly current worker.
ok(_isWorkerStale({ workerVersion: null, sourceVersion: "2", reachable: false }) === false,
  "probe unreachable (worker busy typing) → not stale");
ok(_isWorkerStale({ workerVersion: null, sourceVersion: "2", reachable: true }) === true,
  "reachable but no VERSION support → legacy worker → stale");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
