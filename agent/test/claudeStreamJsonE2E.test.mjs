// E2E test verifying Claude CLI stream-json interactive mode
// Run: node agent/test/claudeStreamJsonE2E.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";

let pass = 0;
let fail = 0;

async function runTest(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

await runTest("claude stream-json emits init, text delta, and result", async () => {
  const claude = spawn("claude", [
    "-p",
    "--verbose",
    "--input-format=stream-json",
    "--output-format=stream-json",
    "--include-partial-messages",
    "--max-budget-usd", "0.02",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: claude.stdout });

  let hasInit = false;
  let hasDelta = false;
  let hasResult = false;
  let textOutput = "";
  let sessionId = "";

  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error("Test timed out after 20s"));
    }, 20000);

    rl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (data.type === "system" && data.subtype === "init") {
          hasInit = true;
          sessionId = data.session_id;
        }
        if (data.type === "stream_event" && data.event?.type === "content_block_delta") {
          hasDelta = true;
          textOutput += data.event.delta?.text || "";
        }
        if (data.type === "result") {
          hasResult = true;
          clearTimeout(timeout);
          claude.stdin.end();
          resolve();
        }
      } catch {
        // Ignore unparseable non-JSON lines
      }
    });

    claude.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    claude.on("close", (code) => {
      clearTimeout(timeout);
      if (!hasResult && code !== 0) {
        reject(new Error(`Claude process exited unexpectedly with code ${code}`));
      }
    });
  });

  // Send prompt
  claude.stdin.write(JSON.stringify({
    type: "user",
    message: { role: "user", content: "Trả lời đúng 1 chữ: PONG" },
  }) + "\n");

  await completed;

  assert.ok(hasInit, "Must receive system init event");
  assert.ok(sessionId, "Must receive a valid session_id");
  assert.ok(hasDelta, "Must receive content_block_delta events");
  assert.ok(textOutput.includes("PONG"), `Output should contain PONG, got: "${textOutput}"`);
  assert.ok(hasResult, "Must receive result completion event");
});

console.log(`\nTests finished: ${pass} passed, ${fail} failed.`);
if (fail > 0) {
  process.exit(1);
}
