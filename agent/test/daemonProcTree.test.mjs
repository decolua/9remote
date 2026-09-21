// Live check that proc.stop kills a managed CLI's whole process group (daemon runs in a temp NREMOTE_HOME).
// Run: node agent/test/daemonProcTree.test.mjs
//
// The grandchild traps SIGINT and touches a marker: only a GROUP signal reaches it
// (a single-pid SIGINT never does, and SIGKILL cannot run the trap), so the marker
// proves the stop propagated the way a closed terminal tab would.
import assert from "node:assert/strict";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";

if (process.platform === "win32") {
  console.log("daemonProcTree: skipped on Windows (POSIX group semantics)");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-proc-tree-"));
const SOCK = path.join(TMP, "pty-daemon.sock");
const MARKER = path.join(TMP, "hit");

fs.writeFileSync(path.join(TMP, "sub.sh"), 'trap \'touch "$MARKER"; exit 0\' INT\nwhile :; do sleep 0.2; done\n');
// A shell `&` background job is born with SIGINT ignored (POSIX async-list rule), so it
// would prove nothing — real harnesses (claude/codex) spawn children with default
// dispositions, and this stand-in CLI does the same.
fs.writeFileSync(path.join(TMP, "cli.mjs"), [
  'import { spawn } from "node:child_process";',
  'const sub = spawn("bash", [process.env.SUB_SCRIPT], { stdio: ["ignore", "inherit", "inherit"] });',
  'console.log(`SUB=${sub.pid}`);',
  'sub.on("exit", () => process.exit(0));',
  ""
].join("\n"));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

// kill(pid,0) succeeds on zombies too — ps distinguishes the dead from the unreaped.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\s*Z/.test(execSync(`ps -p ${pid} -o stat=`).toString()); } catch { return false; }
};

const daemon = spawn(process.execPath, [path.join(__dirname, "..", "features", "terminal", "ptyDaemon.js")], {
  env: { ...process.env, NREMOTE_HOME: TMP },
  stdio: ["ignore", "ignore", "pipe"]
});
daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));

// NDJSON request/reply over the daemon socket, keyed on requestId.
const pending = new Map();
let reqId = 0;
let buffer = "";
let sock = null;

function connect() {
  return new Promise((resolve, reject) => {
    const tryOnce = (attempt) => {
      const s = net.connect(SOCK, () => { sock = s; resolve(); });
      s.on("error", (e) => {
        s.destroy();
        if (attempt < 50) setTimeout(() => tryOnce(attempt + 1), 100);
        else reject(e);
      });
    };
    tryOnce(0);
  });
}

function call(type, args = {}) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ type, requestId: id, ...args }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${type} timeout`)); }
    }, 5000);
  });
}

console.log("Running daemon proc tree tests...");

let subPid = null;
try {
  await connect();
  sock.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.requestId && pending.has(msg.requestId)) {
          pending.get(msg.requestId)(msg);
          pending.delete(msg.requestId);
        }
      } catch {}
    }
  });

  await test("proc.stop group-signals the CLI's grandchildren (INT trap fires)", async () => {
    const start = await call("proc.start", {
      procId: "tree", bin: process.execPath, args: [path.join(TMP, "cli.mjs")], cwd: TMP,
      env: { MARKER, SUB_SCRIPT: path.join(TMP, "sub.sh") }
    });
    assert.equal(start.success, true, "proc.start failed");

    // The SUB= line is the CLI telling us its child's pid — and that the trap is armed.
    for (let i = 0; i < 30 && !subPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await call("proc.lines", { procId: "tree", from: 0 });
      for (const l of res.lines || []) {
        const m = Buffer.from(l.data, "base64").toString("utf8").match(/SUB=(\d+)/);
        if (m) subPid = Number(m[1]);
      }
    }
    assert.ok(subPid, "grandchild pid never appeared in proc lines");
    assert.equal(alive(subPid), true, "grandchild not running before stop");

    const stop = await call("proc.stop", { procId: "tree" });
    assert.equal(stop.success, true, "proc.stop failed");

    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 50));
      hit = fs.existsSync(MARKER);
    }
    assert.ok(hit, "grandchild never saw the group SIGINT");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(alive(subPid), false, "grandchild still alive after stop");
  });
} catch (err) {
  fail++;
  console.error(`  ✗ harness: ${err.message}`);
} finally {
  try { daemon.kill("SIGTERM"); } catch {}
  if (subPid) { try { process.kill(subPid, "SIGKILL"); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
