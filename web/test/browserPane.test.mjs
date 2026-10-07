// Remote browser pane — pure helpers self-check.
// Run: node --import ./test/loader-alias.mjs test/browserPane.test.mjs
import assert from "node:assert/strict";
import { viewportPoint, containRect } from "../features/browser/lib/pointerMap.js";
import { cleanTabTitle, useBrowserStore } from "../shared/stores/browserStore.js";
import { parseSiteAddress } from "../features/browser/lib/siteBridge.js";
import { buildPickPayload } from "../features/browser/lib/pickPayload.js";
import { resolveOmniboxInput } from "../features/browser/lib/omnibox.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("cleanTabTitle strips the engine's 🚀 stamp", () => {
  assert.equal(cleanTabTitle("🚀 [2] My Page"), "My Page");
  assert.equal(cleanTabTitle("🚀 [12]"), "");
  assert.equal(cleanTabTitle("Plain title"), "Plain title");
  assert.equal(cleanTabTitle(null), "");
});

test("buildPickPayload compiles picked elements with optional fields", () => {
  const out = buildPickPayload([
    { tag: "button", selector: "#login > button", text: "Sign in", href: null, rect: { x: 10, y: 20, width: 88, height: 32 } },
    { tag: "h1", selector: "h1", text: "", href: "https://x.test" }
  ], "https://example.test");
  assert.ok(out.startsWith("## Browser Elements (2)\nPage: https://example.test"));
  assert.ok(out.includes("### 1. `<button>`"));
  assert.ok(out.includes('- Selector: `#login > button`'));
  assert.ok(out.includes('- Text: "Sign in"'));
  assert.ok(out.includes("- Rect: 10,20 88×32"));
  assert.ok(out.includes("- Link: https://x.test"));
  assert.equal(out.match(/- Text:/g)?.length, 1); // empty text omitted
  assert.equal(out.match(/- Rect:/g)?.length, 1); // missing rect omitted
});

test("buildPickPayload counts even when fields are missing", () => {
  const out = buildPickPayload([{ tag: "div" }]);
  assert.ok(out.startsWith("## Browser Elements (1)"));
  assert.ok(out.includes("### 1. `<div>`"));
  assert.ok(out.includes("- Selector: `div`"));
});

test("viewportPoint maps image px to viewport CSS px", () => {
  const rect = { width: 400, height: 800 };
  const meta = { deviceWidth: 800, deviceHeight: 1600, scale: 1 };
  const p = viewportPoint(100, 200, rect, meta);
  assert.equal(p.x, 200);
  assert.equal(p.y, 400);
});

test("viewportPoint divides by pinch scale", () => {
  const p = viewportPoint(0, 0, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(p.x, 0);
  const half = viewportPoint(200, 400, { width: 400, height: 800 }, { deviceWidth: 800, deviceHeight: 1600, scale: 2 });
  assert.equal(half.x, 200);
  assert.equal(half.y, 400);
});

test("viewportPoint falls back to the rect when meta is missing", () => {
  const p = viewportPoint(50, 100, { width: 100, height: 200 }, null);
  assert.equal(p.x, 50);
  assert.equal(p.y, 100);
});

test("viewportPoint accounts for object-contain letterboxing", () => {
  // Square page inside a tall stage: drawn image is 400x400 offset y=200.
  const meta = { deviceWidth: 800, deviceHeight: 800, scale: 1 };
  const p = viewportPoint(200, 400, { width: 400, height: 800 }, meta);
  assert.equal(p.x, 400);
  assert.equal(p.y, 400);
  // A tap inside the top letterbox bar clamps to the image edge, not negative.
  const top = viewportPoint(200, 50, { width: 400, height: 800 }, meta);
  assert.equal(top.y, 0);
});

test("containRect centers a contain-fit image", () => {
  const r = containRect(400, 800, 800, 800);
  assert.equal(r.w, 400);
  assert.equal(r.h, 400);
  assert.equal(r.x, 0);
  assert.equal(r.y, 200);
});

test("browserStore setTabs/setActive", () => {
  useBrowserStore.getState().setTabs([{ id: "A", title: "x" }]);
  assert.equal(useBrowserStore.getState().tabs.length, 1);
  useBrowserStore.getState().setTabs(null);
  assert.equal(useBrowserStore.getState().tabs.length, 0);
  useBrowserStore.getState().setActive("A");
  assert.equal(useBrowserStore.getState().activeTargetId, "A");
});

test("parseSiteAddress: public hosts alongside localhost ports", () => {
  assert.deepEqual(parseSiteAddress("vnexpress.net"), { host: "vnexpress.net", path: "/" });
  assert.deepEqual(parseSiteAddress("https://example.com/a?b=1"), { host: "example.com", path: "/a?b=1" });
  assert.deepEqual(parseSiteAddress("WWW.Example.CO.UK/x"), { host: "www.example.co.uk", path: "/x" });
  assert.equal(parseSiteAddress("192.168.1.1"), null); // IP literals are not site hosts
  assert.deepEqual(parseSiteAddress("localhost:3000/x"), { port: 3000, path: "/x" });
  assert.deepEqual(parseSiteAddress(":3000"), { port: 3000, path: "/" });
  assert.deepEqual(parseSiteAddress("/about", 3000), { port: 3000, path: "/about" });
  assert.equal(parseSiteAddress("how to center a div"), null); // caller turns this into a search
});

test("resolveOmniboxInput: URLs vs search queries", () => {
  assert.equal(resolveOmniboxInput(""), null);
  assert.equal(resolveOmniboxInput("   "), null);

  // Full URL with scheme
  assert.deepEqual(resolveOmniboxInput("https://github.com"), { url: "https://github.com", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("http://example.com/test"), { url: "http://example.com/test", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("about:blank"), { url: "about:blank", isSearch: false });

  // Bare domains and IPs become https://
  assert.deepEqual(resolveOmniboxInput("google.com"), { url: "https://google.com", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("localhost:3000"), { url: "https://localhost:3000", isSearch: false });
  assert.deepEqual(resolveOmniboxInput("192.168.1.1:8080/path"), { url: "https://192.168.1.1:8080/path", isSearch: false });

  // Search queries with spaces or non-host strings
  assert.deepEqual(resolveOmniboxInput("hello world"), {
    url: "https://www.google.com/search?q=hello%20world",
    isSearch: true
  });
  assert.deepEqual(resolveOmniboxInput("react vs vue 2026"), {
    url: "https://www.google.com/search?q=react%20vs%20vue%202026",
    isSearch: true
  });
  assert.deepEqual(resolveOmniboxInput("justaword"), {
    url: "https://www.google.com/search?q=justaword",
    isSearch: true
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
