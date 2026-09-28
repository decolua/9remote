// Orphan-proc sweep: a daemon proc lives only while its chat is live in memory
// or its snapshot was touched within STALE_CHAT_MS; a delete for a chat this
// run never loaded must still stop the proc and drop the snapshot.
//
// Run: node host/test/aiOrphanSweep.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NREMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nremote-sweep-"));

const { sweepOrphanProcs, destroyDetachedChat, globalAiManager, etimeSeconds, parseOrphanClaude } = await import("../features/ai/aiManager.js");
const { STALE_CHAT_MS, ORPHAN_CLAUDE_GRACE_MS } = await import("../features/ai/constants.js");

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const snapshotsDir = path.join(process.env.NREMOTE_HOME, "ai-sessions");
const snapshot = (id) => path.join(snapshotsDir, `claude-${id}.json`);
const writeSnapshot = (id, ageMs = 0) => {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const file = snapshot(id);
  fs.writeFileSync(file, "{}");
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
  }
  return file;
};
const mkClient = (procIds) => {
  const stopped = [];
  return {
    stopped,
    isConnected: () => true,
    procList: async () => ({ procs: procIds.map((procId) => ({ procId })) }),
    procStop: async (id) => { stopped.push(id); }
  };
};

console.log("Running orphan sweep tests...");

test("etimeSeconds parses every ps elapsed format", () => {
  assert.equal(etimeSeconds("14:22"), 14 * 60 + 22);
  assert.equal(etimeSeconds("10:22:07"), 10 * 3600 + 22 * 60 + 7);
  assert.equal(etimeSeconds("01-03:38:46"), ((1 * 24 + 3) * 60 + 38) * 60 + 46);
  assert.equal(etimeSeconds("garbage"), 0);
});

test("parseOrphanClaude matches only old launchd-reparented claude procs", () => {
  const oldEnough = `${Math.floor(ORPHAN_CLAUDE_GRACE_MS / 3600000) + 1}:00:00`;
  const tooYoung = "00:30:00";
  const lines = [
    "  PID  PPID  PGID ETIME ARGS",
    `  100     1   100 ${oldEnough} claude -p --verbose --resume abc`,
    `  101     1   101 ${tooYoung} claude -p --verbose`,
    `  102   85897   102 ${oldEnough} claude -p --verbose`,
    `  103     1   103 ${oldEnough} /Users/x/.local/bin/claude --resume def`,
    `  104     1   104 ${oldEnough} node server.js`,
  ];
  assert.deepEqual(parseOrphanClaude(lines), [{ pid: 100, pgid: 100 }, { pid: 103, pgid: 103 }]);
});

await test("proc with no snapshot is swept", async () => {
  const client = mkClient(["gone-chat"]);
  await sweepOrphanProcs(client);
  assert.deepEqual(client.stopped, ["gone-chat"]);
});

await test("proc with a fresh snapshot is kept", async () => {
  writeSnapshot("fresh-chat");
  const client = mkClient(["fresh-chat"]);
  await sweepOrphanProcs(client);
  assert.deepEqual(client.stopped, []);
});

await test("proc with a stale snapshot is swept", async () => {
  writeSnapshot("stale-chat", STALE_CHAT_MS + 60 * 60 * 1000);
  const client = mkClient(["stale-chat"]);
  await sweepOrphanProcs(client);
  assert.deepEqual(client.stopped, ["stale-chat"]);
});

await test("proc for a session live in memory is kept", async () => {
  globalAiManager.sessions.set("live-chat", {});
  try {
    const client = mkClient(["live-chat"]);
    await sweepOrphanProcs(client);
    assert.deepEqual(client.stopped, []);
  } finally {
    globalAiManager.sessions.delete("live-chat");
  }
});

await test("destroyDetachedChat stops the proc and unlinks the snapshot", async () => {
  const file = writeSnapshot("detached-chat");
  const client = mkClient(["detached-chat"]);
  await destroyDetachedChat("detached-chat", client);
  assert.ok(client.stopped.includes("detached-chat"), "procStop not called");
  assert.ok(!fs.existsSync(file), "snapshot still on disk");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
