import test from "node:test";
import assert from "node:assert/strict";
import { resolveTab, syncTabOrder } from "../features/browserUse/engine.js";

test("syncTabOrder: maintains stable order regardless of Chrome shuffle", () => {
  const session = { tabOrder: [] };
  const t1 = { targetId: "AAA", title: "Tab 1", url: "http://a.com" };
  const t2 = { targetId: "BBB", title: "Tab 2", url: "http://b.com" };
  const t3 = { targetId: "CCC", title: "Tab 3", url: "http://c.com" };

  // First observation: order is A, B
  let ordered = syncTabOrder(session, [t1, t2]);
  assert.deepEqual(ordered.map((t) => t.targetId), ["AAA", "BBB"]);

  // Chrome shuffles: returns B, A
  ordered = syncTabOrder(session, [t2, t1]);
  // Must preserve stable original order A, B!
  assert.deepEqual(ordered.map((t) => t.targetId), ["AAA", "BBB"]);

  // New tab C arrives
  ordered = syncTabOrder(session, [t3, t2, t1]);
  // C is appended to end: A, B, C
  assert.deepEqual(ordered.map((t) => t.targetId), ["AAA", "BBB", "CCC"]);

  // Tab A is closed: returns C, B
  ordered = syncTabOrder(session, [t3, t2]);
  // A is dropped, B then C
  assert.deepEqual(ordered.map((t) => t.targetId), ["BBB", "CCC"]);
});

test("resolveTab: resolves by 1-based index or #number", () => {
  const pages = [
    { targetId: "A111", title: "Dashboard", url: "http://site.com/dash" },
    { targetId: "B222", title: "Settings", url: "http://site.com/settings" },
    { targetId: "C333", title: "Shop Cart", url: "http://shop.com/cart" },
  ];

  assert.equal(resolveTab(pages, 1).targetId, "A111");
  assert.equal(resolveTab(pages, "2").targetId, "B222");
  assert.equal(resolveTab(pages, "#3").targetId, "C333");
  assert.throws(() => resolveTab(pages, 0), /No tab #0/);
  assert.throws(() => resolveTab(pages, 4), /No tab #4/);
});

test("resolveTab: resolves by targetId or prefix", () => {
  const pages = [
    { targetId: "C4F75DA7A8CC9822ECC6423CE5A67D90", title: "H8", url: "http://127.0.0.1:5893/h8" },
    { targetId: "9A1234567890ABCDEF1234567890ABCD", title: "Home", url: "http://127.0.0.1:5893/" },
  ];

  assert.equal(resolveTab(pages, "C4F75DA7A8CC9822ECC6423CE5A67D90").targetId, "C4F75DA7A8CC9822ECC6423CE5A67D90");
  assert.equal(resolveTab(pages, "C4F7").targetId, "C4F75DA7A8CC9822ECC6423CE5A67D90");
  assert.equal(resolveTab(pages, "c4f7").targetId, "C4F75DA7A8CC9822ECC6423CE5A67D90");
  assert.equal(resolveTab(pages, "9A12").targetId, "9A1234567890ABCDEF1234567890ABCD");
});

test("resolveTab: resolves by URL or title substring", () => {
  const pages = [
    { targetId: "T1", title: "GitHub - Repo", url: "https://github.com/my/repo" },
    { targetId: "T2", title: "H8 - Iframe", url: "http://127.0.0.1:5893/h8" },
    { targetId: "T3", title: "H10 - Mega Journey", url: "http://127.0.0.1:5893/h10" },
  ];

  assert.equal(resolveTab(pages, "github").targetId, "T1");
  assert.equal(resolveTab(pages, "H8").targetId, "T2");
  assert.equal(resolveTab(pages, "/h10").targetId, "T3");
  assert.equal(resolveTab(pages, "mega").targetId, "T3");
  assert.throws(() => resolveTab(pages, "nonexistent"), /No tab matching "nonexistent"/);
});
