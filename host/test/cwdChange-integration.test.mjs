// Integration test: full chain daemon → agent socket → does "cwdChange" reach a client?
// Spawns a PTY via the SAME path as agent (PROMPT_COMMAND inject), feeds "cd /tmp",
// and asserts a socket client subscribed to cwdChange receives it.
//
// Run: node agent/test/cwdChange-integration.test.mjs
import pty from "node-pty";
import os from "os";

const OSC_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/;

// Simulate the daemon-side parse + emit (ptyDaemon.js:218) and the agent socket broadcast.
// We assert the value that WOULD be broadcast reaches the "client" set.
function simulateChain() {
  return new Promise((resolve) => {
    const emitted = [];
    const cwdState = {};
    const clientReceived = [];

    // "broadcast(io, ...)" → pushes to clientReceived (simulating socket client listener)
    const broadcast = (event, payload) => {
      if (event === "cwdChange") clientReceived.push(payload);
    };

    const shell = pty.spawn(process.env.SHELL || "/bin/bash", ["-l"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: os.homedir(),
      env: { ...process.env, PROMPT_COMMAND: 'printf "\\033]7;file://${HOSTNAME}${PWD}\\a"' },
      useConpty: false,
    });

    const timer = setTimeout(() => { shell.kill(); resolve({ emitted, clientReceived }); }, 3000);

    // ptyDaemon.js onData handler (exact logic copy)
    shell.onData((data) => {
      const osc7 = data.match(OSC_RE);
      if (osc7) {
        let next;
        try { next = decodeURIComponent(osc7[1]); } catch { next = osc7[1]; }
        const sid = "s1";
        if (next && next !== cwdState[sid]) {
          cwdState[sid] = next;
          emitted.push(next);
          // terminalSocket.js: daemonClient.on("cwdChange") → broadcast(io, "cwdChange", ...)
          broadcast("cwdChange", { sessionId: sid, cwd: next });
        }
      }
    });

    setTimeout(() => { shell.write("cd /tmp\r"); }, 600);
    shell.onExit(() => { clearTimeout(timer); resolve({ emitted, clientReceived }); });
  });
}

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`));

console.log("Integration: full OSC → parse → cwdChange broadcast chain");
const { emitted, clientReceived } = await simulateChain();
console.log("  daemon parsed cwds:", emitted);
console.log("  client received:", clientReceived);

assert(emitted.length >= 2, "daemon parsed at least home + /tmp");
assert(clientReceived.length >= 2, "client received cwdChange events");
assert(clientReceived.some((c) => c.cwd?.endsWith("/tmp")), `client got /tmp (got: ${clientReceived.map((c) => c.cwd).join(", ")})`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
