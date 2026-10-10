// Agent tabs are stamped with the terminal session that opened them (tabKey = the
// CLI's NINE_REMOTE_SESSION_ID), so the strip can show each workspace only its own
// agent's tabs. Real Chrome headless, data: pages — no network.
// Run: node host/test/browserAgentOwner.test.mjs
import assert from "node:assert/strict";
import "./chromeGuard.mjs";
import { invoke } from "../features/browserUse/browserUseSocket.js";
import { agentTabsSnapshot, profiles, closeProfile, beginAgentCall, withSession } from "../features/browserUse/engine.js";
import { closeBrowser, resolveChromeBinary } from "../features/browser/browserEngine.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

if (!resolveChromeBinary()) {
  console.log("  - skipped (no Chrome binary found)");
} else {
  const profile = `owner-${Date.now().toString(36)}`;
  profiles.create(profile);
  const page = (title) => `data:text/html,<title>${title}</title>${title}`;
  const go = (tabKey, title, extra = {}) =>
    invoke("go", { mode: "own", profile, url: page(title), ...(tabKey ? { tabKey } : {}), ...extra });
  const ownerOf = async (title) => (await agentTabsSnapshot()).find((t) => t.title === title)?.owner;

  await test("a tab opened by a named caller is owned by it", async () => {
    await go("session-111", "alpha");
    assert.equal(await ownerOf("alpha"), "session-111");
  });

  await test("a second caller's new tab is its own; the first keeps its tab", async () => {
    await go("session-222", "beta", { newTab: true });
    assert.equal(await ownerOf("beta"), "session-222");
    assert.equal(await ownerOf("alpha"), "session-111");
  });

  await test("owner survives later calls by another caller (claim never steals)", async () => {
    await invoke("tabs", { mode: "own", profile, tabKey: "session-333" });
    assert.equal(await ownerOf("alpha"), "session-111");
    assert.equal(await ownerOf("beta"), "session-222");
  });

  await test("a call with no caller leaves its tab ownerless (strip shows it everywhere)", async () => {
    await go(null, "gamma", { newTab: true });
    assert.equal(await ownerOf("gamma"), null);
  });

  await test("a caller that only READS never claims an ownerless tab", async () => {
    await invoke("tabs", { mode: "own", profile, tabKey: "session-777" });
    assert.equal(await ownerOf("gamma"), null, "gamma was opened by nobody-in-app; listing tabs must not adopt it");
  });

  // Opening through withSession (not invoke) is a tab born mid-call from the poll's view.
  const openDirect = (title) => withSession({ mode: "own", profile, url: page(title), newTab: true }, async (s) => s.mode);

  await test("a tab shown mid-call is already owned by the sole in-flight caller", async () => {
    const end = beginAgentCall(profile, "session-444");
    try {
      await openDirect("delta");
      assert.equal(await ownerOf("delta"), "session-444"); // poll ran before the call returned
    } finally { end(); }
  });

  await test("a tab that already existed when the call began is never claimed", async () => {
    const end = beginAgentCall(profile, "session-888");
    try { assert.equal(await ownerOf("gamma"), null); } finally { end(); }
    assert.equal(await ownerOf("gamma"), null);
  });

  await test("two callers in flight = ambiguous, nothing is claimed", async () => {
    const endA = beginAgentCall(profile, "session-555");
    const endB = beginAgentCall(profile, "session-666");
    try {
      await openDirect("epsilon");
      assert.equal(await ownerOf("epsilon"), null);
    } finally { endA(); endB(); }
    assert.equal(await ownerOf("epsilon"), null, "still ownerless after both finish");
  });

  await test("an untagged call overlapping a tagged one makes it ambiguous too", async () => {
    const end = beginAgentCall(profile, "session-999");
    try {
      await go(null, "eta", { newTab: true }); // untagged invoke runs while 999 is in flight
      assert.equal(await ownerOf("eta"), null);
    } finally { end(); }
    assert.equal(await ownerOf("eta"), null);
  });

  await test("a malformed caller id is ignored", async () => {
    await go("../../etc/passwd", "zeta", { newTab: true });
    assert.equal(await ownerOf("zeta"), null);
  });

  await closeProfile(profile).catch(() => {});
  await closeBrowser(profile).catch(() => {});
  await profiles.remove(profile).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
