// TDD contract + e2e for browserUse. Run: node host/test/browserUse.test.mjs
// Pure parts run everywhere. The e2e launches real Chrome with a FAKE decide()
// (offline, deterministic) and skips gracefully when no Chrome exists.
// Real-Jev e2e: BROWSER_USE_E2E_REAL=1 + configured presets (manual, costs nothing on free lane).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { validateChoice, resolveJevConfig } from "../features/browserUse/jevClient.js";
import {
  buildActionSpace, shouldBlockNoChange, buildQuestions
} from "../features/browserUse/agentLoop.js";
let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("browserUse contracts...");

await test("validateChoice accepts a calibrated answer", () => {
  const answer = { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.1 } };
  assert.equal(validateChoice(answer, ["CLICK", "DONE"]), answer);
});

await test("validateChoice rejects wrong key set, bad sum, non-max choice", () => {
  const badKeys = { choice: "CLICK", confidence: 1, probabilities: { CLICK: 1 } };
  assert.equal(validateChoice(badKeys, ["CLICK", "DONE"]), null);
  const badSum = { choice: "CLICK", confidence: 0.6, probabilities: { CLICK: 0.6, DONE: 0.6 } };
  assert.equal(validateChoice(badSum, ["CLICK", "DONE"]), null);
  const notMax = { choice: "DONE", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.1 } };
  assert.equal(validateChoice(notMax, ["CLICK", "DONE"]), null);
});

await test("resolveJevConfig: free lane headers, model default, url normalize", () => {
  const cfg = resolveJevConfig({ preset: "free" });
  assert.equal(cfg.url, "https://opencode.ai/zen/v1/systemone");
  assert.equal(cfg.model, "jev-1.13-free");
  assert.equal(cfg.headers.Authorization, "Bearer public");
  assert.match(cfg.headers["User-Agent"], /^opencode\//);
  assert.ok(cfg.headers["x-opencode-session"].startsWith("ses_"));
});

await test("resolveJevConfig: custom endpoint gets /systemone appended, key used", () => {
  const cfg = resolveJevConfig({ preset: "custom", endpoint: "https://my.host/api/v1", model: "m1", apiKey: "k" });
  assert.equal(cfg.url, "https://my.host/api/v1/systemone");
  assert.equal(cfg.headers.Authorization, "Bearer k");
  assert.equal(cfg.headers["x-opencode-client"], undefined);
});

await test("resolveJevConfig: missing endpoint/model is an error", () => {
  assert.ok(resolveJevConfig({ preset: "custom" }).error);
  assert.ok(resolveJevConfig({ preset: "custom", endpoint: "https://x/y" }).error);
});

await test("buildActionSpace: every clickable element offered, fills excluded", () => {
  const actions = [
    { id: "e1", kind: "click", label: "Next page", role: "button", value: "", node: 1 },
    { id: "e2", kind: "click", label: "Delete everything", role: "button", value: "", node: 2 },
    { id: "e3", kind: "fill", label: "Email", role: "textbox", value: "", node: 3 },
    { id: "wait", kind: "wait", label: "Wait" },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 }
  ];
  const space = buildActionSpace(actions);
  assert.deepEqual(Object.keys(space.targets.CLICK).sort(), ["e1", "e2"]);
  assert.ok(space.controls.WAIT);
  assert.ok(space.controls.SCROLL_DOWN);
});

await test("buildQuestions: only offered ids appear as criteria", () => {
  const actions = [
    { id: "e1", kind: "click", label: "Open menu", role: "button", value: "", node: 1 },
    { id: "wait", kind: "wait", label: "Wait" }
  ];
  const space = buildActionSpace(actions);
  const body = buildQuestions({ url: "https://x", title: "t", text: "hi", actions }, "open the menu", [], space);
  assert.deepEqual(Object.keys(body.questions.operation.criteria).sort(),
    ["BLOCKED", "CLICK", "DONE", "WAIT"]);
  assert.deepEqual(Object.keys(body.questions.click_target.criteria), ["e1"]);
  assert.equal(body.state.page.url, "https://x");
});

await test("shouldBlockNoChange: three stale non-wait actions block", () => {
  const hist = (n) => Array.from({ length: n }, () => ({ page_changed: false, kind: "click" }));
  assert.equal(shouldBlockNoChange(hist(3)), true);
  assert.equal(shouldBlockNoChange(hist(2)), false);
  assert.equal(shouldBlockNoChange([{ page_changed: false, kind: "click" }, { page_changed: false, kind: "click" }, { page_changed: false, kind: "wait" }]), false);
});

// ---------------------------------------------------------------------------
// E2E: real Chrome + real snapshot/act, FAKE Jev (deterministic, offline).
// ---------------------------------------------------------------------------
const hasChrome = (() => {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
       "/Applications/Chromium.app/Contents/MacOS/Chromium",
       "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["google-chrome", "chromium", "chromium-browser"];
  if (process.platform === "darwin") return candidates.some((p) => fs.existsSync(p));
  return candidates.some((c) => { try { fs.accessSync(`/usr/bin/${c}`); return true; } catch { return false; } });
})();

if (!hasChrome) {
  console.log("  - e2e skipped (no Chrome binary found)");
} else {
  console.log("browserUse e2e (real Chrome, fake Jev)...");
  const engine = await import("../features/browserUse/engine.js");
  const { withSession, observe, runTask, typeById, pressEnter, deleteProfile } = engine;

  const pageHtml = `<!doctype html><html><body>
    <button id="b" onclick="document.title='CLICKED';this.dataset.done='1'">Click me</button>
    <button id="d" onclick="document.title='DELETED'">Delete all</button>
  </body></html>`;

  await test("e2e: fake Jev clicks the right button; deny policy holds", async () => {
    const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(pageHtml); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const profile = `e2e-${Date.now()}`;
    try {
      const result = await withSession({ profile, url, headless: true }, async (session) => {
        let calls = 0;
        // Fake decide: click "Click me" once, then declare DONE.
        const fakeDecide = async ({ questions }) => {
          calls++;
          const criteria = questions.click_target?.criteria || {};
          const found = calls <= 1 ? Object.entries(criteria).find(([, v]) => /click me/i.test(v.element || "")) : null;
          if (found) {
            const [idx] = found;
            const probabilities = {}; for (const k of Object.keys(criteria)) probabilities[k] = k === idx ? 1 : 0;
            return { answers: {
              operation: { choice: "CLICK", confidence: 1, probabilities: { CLICK: 1, DONE: 0, BLOCKED: 0, WAIT: 0 } },
              click_target: { choice: idx, confidence: 1, probabilities }
            }, model: "fake", usage: {} };
          }
          return { answers: {
            operation: { choice: "DONE", confidence: 1, probabilities: { CLICK: 0, DONE: 1, BLOCKED: 0, WAIT: 0 } }
          }, model: "fake", usage: {} };
        };
        return await runTask(session, { goal: "Click the Click me button", decide: fakeDecide, maxSteps: 5, maxMs: 20000 });
      });
      assert.equal(result.outcome, "needs_verification");
      const clicked = result.steps.some((s) => /click me/i.test(s.label) && s.result === "ok");
      assert.ok(clicked, "clicked the right element");
      assert.ok(result.steps.every((s) => s.operation !== "TYPE_TEXT"), "fill element never offered to Jev");
    } finally {
      server.close();
      await deleteProfile(profile).catch(() => {});
    }
  });

  await test("e2e: type into observed field + enter via single-step commands", async () => {
    const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<!doctype html><html><body>
      <input id="q" placeholder="Search" onkeydown="if(event.key==='Enter')document.title='SENT:'+this.value">
    </body></html>`); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const profile = `e2e2-${Date.now()}`;
    try {
      await withSession({ profile, url, headless: true }, async (session) => {
        const field = (await observe(session)).actions.find((a) => a.kind === "fill");
        assert.ok(field, "field observed");
        await typeById(session, field.id, "test chào mày");
        await pressEnter(session);
        const state = await observe(session);
        assert.equal(state.title, "SENT:test chào mày");
      });
    } finally {
      server.close();
      await deleteProfile(profile).catch(() => {});
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
