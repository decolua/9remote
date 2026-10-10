// TDD suite for the one-shot browser interface: 3 CLI commands (chain/batch/jev),
// 14 canonical ops (read/search/find/run/shot/upload...), verb guard, pendingSteps
// repair, read-only nudge. Real Chrome headless + local fixtures, fake Jev offline.
// Run: node host/test/browserOneShot.test.mjs   (CASES=1,7 to subset)
import assert from "node:assert/strict";
import "./chromeGuard.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { invoke, setConfig } from "../features/browserUse/browserUseSocket.js";
import { agentBlockedSub, parseStep, cmdBrowser } from "../cli/modes/browserCmd.js";

let pass = 0, fail = 0;
const onlyCases = process.env.CASES?.split(",");
const test = async (name, fn) => {
  if (onlyCases && !onlyCases.some((n) => name.startsWith(`${n}.`))) return;
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const hasChrome = (() => {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
       "/Applications/Chromium.app/Contents/MacOS/Chromium",
       "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["google-chrome", "chromium", "chromium-browser"];
  if (process.platform === "darwin") return candidates.some((p) => fs.existsSync(p));
  return candidates.some((c) => { try { fs.accessSync(`/usr/bin/${c}`); return true; } catch { return false; } });
})();

// ---------------------------------------------------------------- fixtures ---
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`;
const PAGES = {
  // Login -> dashboard -> export funnel, all client-side phase swaps (no nav).
  "/app": page(`
    <div id="s1">
      <input placeholder="Email"><input type="password" placeholder="Password">
      <button onclick="document.getElementById('s1').style.display='none';document.getElementById('s2').style.display='block'">Sign in</button>
    </div>
    <div id="s2" style="display:none"><h2>Dashboard</h2>
      <select onchange="document.title='ROLE:'+this.value"><option value="">Choose role</option><option value="Admin">Admin</option><option value="Viewer">Viewer</option></select>
      <button onclick="document.getElementById('s2').style.display='none';document.getElementById('s3').style.display='block'">Export data</button>
    </div>
    <div id="s3" style="display:none"><h2>Export complete</h2><p>Total rows: 128</p><a href="/report">Open report</a></div>`),
  "/form": page(`
    <input placeholder="Full name">
    <input type="file" aria-label="CV" onchange="document.title='UPLOADED:'+this.files[0].name">
    <p>Total submitted: 1</p>`),
  // Late content is INSERTED at 4000ms — absent from the DOM until then, so
  // neither the first read nor the 800ms self-heal can ever see it.
  "/late": page(`<div>spinner…</div>
    <script>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<p>SLOW-PAYLOAD-READY</p>')},4000)<\/script>`),
  "/banner": page(`
    <h1>Premium active</h1>
    <button onclick="document.title='UPGRADED'">Upgrade</button>
    <button onclick="document.title='CONTINUED'">Continue</button>`),
  "/wizard": page(`
    <div id="w1"><input placeholder="Project name">
      <select onchange="document.title='TIER:'+this.value"><option value="">Choose tier</option><option value="pro">pro</option></select>
      <button onclick="w(1)">Next</button></div>
    <div id="w2" style="display:none"><input placeholder="API key"><button onclick="w(2)">Next</button></div>
    <div id="w3" style="display:none">
      <select onchange="document.title='PLAN:'+this.value"><option value="">Choose plan</option><option value="team">team</option></select>
      <button onclick="w(3)">Next</button></div>
    <div id="w4" style="display:none"><button onclick="document.getElementById('w4').style.display='none';document.getElementById('done').style.display='block'">Finish</button></div>
    <div id="done" style="display:none"><h2>Wizard complete</h2><a href="/report">Download certificate</a></div>
    <script>function w(n){document.getElementById('w'+n).style.display='none';document.getElementById('w'+(n+1)).style.display='block'}<\/script>`),
  // Real form GET submit: enter sends the browser to /results?q=… (full nav).
  "/search": page(`<form action="/results" method="get"><input name="q" placeholder="Search"></form>`),
  "/results": (q) => page(`<h1>Results for ${q}</h1><button onclick="document.title='NEXT-CLICKED'">Next result</button>`),
  "/hub": page(`<a href="/results?x=1">Open report</a>`)
};

// ------------------------------------------------------------------ guard ----
await test("2. verb guard: only chain/batch/delegate/help survive, error teaches chain", () => {
  for (const ok of ["chain", "batch", "sh", "run", "help", undefined, "--help", "-h"]) {
    assert.equal(agentBlockedSub(ok), null, `${ok} must stay allowed`);
  }
  const blocked = ["go", "click", "type", "select", "enter", "hover", "scroll", "wait",
    "read", "search", "find", "console", "shot", "tabs", "status",
    "close", "attach", "clear", "key", "clickxy", "drag", "upload", "download",
    "back", "forward", "reload", "tabclose"];
  for (const verb of blocked) {
    const err = agentBlockedSub(verb);
    assert.ok(err instanceof Error, `${verb} must be blocked`);
    assert.match(err.message, /chain --steps/, `${verb} error must teach the chain form`);
  }
});

await test("2b. cmdBrowser rejects a stray click BEFORE touching the network", async () => {
  const errs = [];
  const origErr = console.error; console.error = (m) => errs.push(String(m));
  const origCode = process.exitCode;
  try {
    await cmdBrowser(["click", "a12"]);
    assert.equal(process.exitCode, 1, "blocked verb sets exit code 1");
    assert.ok(errs.join("\n").includes("chain --steps"), "error teaches the chain form");
  } finally {
    console.error = origErr; process.exitCode = origCode;
  }
});

await test("2c. parseStep speaks the canonical names (aliases normalize)", () => {
  assert.equal(parseStep('search "Total rows" -C 1').op, "search");
  assert.equal(parseStep('search "Total rows" -C 1').context, 1);
  assert.equal(parseStep("find login").op, "find");
  assert.equal(parseStep("find login").pattern, "login");
  const delegateStep = parseStep('run "sign in" --expect-text "Dashboard"');
  assert.equal(delegateStep.op, "run");
  assert.deepEqual(delegateStep.expectText, ["Dashboard"]);
  assert.equal(parseStep('run "old"').op, "run");
  const up = parseStep('upload "CV" /tmp/9r-cv-test.txt');
  assert.equal(up.op, "upload"); assert.equal(up.label, "CV"); assert.equal(up.file, "/tmp/9r-cv-test.txt");
  assert.equal(parseStep("shot").op, "shot");
  assert.equal(parseStep('search "old" -C 2').op, "search");
  assert.equal(parseStep('find "old"').op, "find");
});

// -------------------------------------------------------------------- e2e ----
if (!hasChrome) {
  console.log("  - e2e skipped (no Chrome binary found)");
} else {
  const engine = await import("../features/browserUse/engine.js");
  const { profiles } = engine;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const u = new URL(req.url, "http://x");
    const entry = PAGES[u.pathname];
    res.end(typeof entry === "function" ? entry(u.searchParams.get("q") ?? "") : (entry || PAGES["/app"]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = Date.now();
  // Pick-only engine: pre-create every profile this suite touches.
  for (const n of ["1","3","4","5","6","7","8","9","10","11","11b","12","12b","12c","13"]) profiles.create(`oneshot-${n}-${stamp}`);
  const chain = (profile, steps, extra = {}) => invoke("chain", { profile, steps, ...extra });
  const cleanup = async (profile) => { await profiles.remove(profile).catch(() => {}); };

  await test("1. one-shot funnel: login -> select -> export -> verify in ONE chain", async () => {
    const profile = `oneshot-1-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "type", label: "Email", text: "me@x.co" },
        { op: "type", label: "Password", text: "hunter2" },
        { op: "click", label: "Sign in" },
        { op: "select", label: "Admin" },
        { op: "click", label: "Export data" },
        { op: "search", pattern: "Total rows: 128" },
        { op: "find", pattern: "Open report" }
      ]);
      assert.equal(res.ok, true, `chain failed: ${JSON.stringify(res.results?.filter((r) => !r.ok))}`);
      assert.equal(res.results.length, 8, "all 8 steps in one shot");
      const text = res.results.find((r) => r.op === "search");
      assert.ok(text.matched >= 1, "text found the export proof");
      const els = res.results.find((r) => r.op === "find");
      assert.ok(els.matched >= 1, "find found the report link");
      assert.match(res.state.title, /^ROLE:Admin/, "select landed");
    } finally { await cleanup(profile); }
  });

  await test("3. new ops live: text + shot (real file) + upload in one chain", async () => {
    const profile = `oneshot-3-${stamp}`;
    fs.writeFileSync("/tmp/9r-cv-test.txt", "cv payload");
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/form` },
        { op: "search", pattern: "Total submitted" },
        { op: "upload", label: "CV", file: "/tmp/9r-cv-test.txt" },
        { op: "shot" }
      ]);
      assert.equal(res.ok, true, JSON.stringify(res.results?.filter((r) => !r.ok)));
      const shot = res.results.find((r) => r.op === "shot");
      assert.ok(shot.path, "shot step returns a file path");
      assert.ok(fs.statSync(shot.path).size > 500, "screenshot file is real");
      assert.match(res.state.title, /^UPLOADED:9r-cv-test\.txt/, "upload landed");
    } finally { await cleanup(profile); fs.rmSync("/tmp/9r-cv-test.txt", { force: true }); }
  });

  await test("4. read/search/find steps inside one chain", async () => {
    const profile = `oneshot-4-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "type", label: "Email", text: "me@x.co" },
        { op: "type", label: "Password", text: "hunter2" },
        { op: "click", label: "Sign in" },
        { op: "read" },
        { op: "search", pattern: "Dashboard" },
        { op: "find", pattern: "Export data" }
      ]);
      assert.equal(res.ok, true, JSON.stringify(res.results?.filter((r) => !r.ok)));
      assert.ok(res.results.find((r) => r.op === "search").matched >= 1, "search matched");
      assert.ok(res.results.find((r) => r.op === "find").matched >= 1, "find matched");
    } finally { await cleanup(profile); }
  });

  await test("5. pendingSteps: the broken chain returns the steps still to run", async () => {
    const profile = `oneshot-5-${stamp}`;
    const todo = [{ op: "type", label: "Email", text: "me@x.co" }, { op: "search", pattern: "Dashboard" }];
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "click", label: "Definitely Not Here" },
        ...todo
      ]);
      assert.equal(res.ok, false);
      assert.equal(res.failedStep, 2);
      assert.deepEqual(res.pending, todo, "repair shot is a copy-paste of the remainder");
      assert.ok(res.state?.url?.includes("/app"), "break state rides along");
    } finally { await cleanup(profile); }
  });

  await test("6. nudge: three read-only chains in a row get called out, action resets", async () => {
    const profile = `oneshot-6-${stamp}`;
    try {
      const r1 = await chain(profile, [{ op: "go", url: `${base}/app` }, { op: "search", pattern: "Sign in" }]);
      const r2 = await chain(profile, [{ op: "search", pattern: "Sign in" }]);
      assert.equal(r1.note, undefined); assert.equal(r2.note, undefined);
      const r3 = await chain(profile, [{ op: "search", pattern: "Sign in" }]);
      assert.match(r3.note ?? "", /read-only/, "third consecutive read-only chain gets the note");
      await chain(profile, [{ op: "type", label: "Email", text: "me@x.co" }]);
      const r5 = await chain(profile, [{ op: "search", pattern: "Sign in" }]);
      assert.equal(r5.note, undefined, "an action chain resets the streak");
    } finally { await cleanup(profile); }
  });

  await test("7. jev delegation nested in chain: fields + expectText + sub-steps", async () => {
    const profile = `oneshot-7-${stamp}`;
    const wasEnabled = (await invoke("config.get")).config.enabled;
    setConfig({ enabled: true }, { persist: false, syncSkill: false }); // transient — no KV, no skill sync
    const calls = [];
    // Deterministic offline Jev: type each field, click Sign in, then DONE.
    const fakeDecide = async ({ questions }) => {
      // Probabilities must cover the EXACT criteria key set or validation rejects.
      const mk = (criteria, choice) => {
        const probabilities = {}; for (const k of Object.keys(criteria)) probabilities[k] = k === choice ? 1 : 0;
        return { choice, confidence: 1, probabilities };
      };
      const answer = (question, want) => {
        const hit = Object.entries(question.criteria).find(([, v]) =>
          want.test(typeof v === "string" ? v : JSON.stringify(v)));
        return hit ? mk(question.criteria, hit[0]) : null;
      };
      calls.push(1);
      const type = questions.type_text_target;
      if (type && calls.length <= 2) {
        const target = answer(type, calls.length === 1 ? /email/i : /password/i);
        if (target) {
          return { answers: {
            operation: mk(questions.operation.criteria, "TYPE_TEXT"),
            type_text_target: target
          } };
        }
      }
      const click = questions.click_target;
      const clickAnswer = click ? answer(click, /sign in/i) : null;
      if (clickAnswer) {
        return { answers: {
          operation: mk(questions.operation.criteria, "CLICK"),
          click_target: clickAnswer
        } };
      }
      return { answers: { operation: mk(questions.operation.criteria, "DONE") } };
    };
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "run", goal: "Sign in with the provided credentials",
          fields: { Email: "me@x.co", Password: "hunter2" }, expectText: ["Dashboard"],
          steps: [{ op: "select", label: "Admin" }, { op: "click", label: "Export data" }] },
        { op: "search", pattern: "Total rows: 128" }
      ], { decide: fakeDecide });
      assert.equal(res.ok, true, JSON.stringify(res.results?.filter((r) => !r.ok)));
      assert.match(res.results.find((r) => r.op === "run").summary, /needs_verification/, "delegated run verified itself");
      assert.ok(res.results.find((r) => r.op === "search").matched >= 1, "post-jev read confirmed the funnel end");
    } finally { setConfig({ enabled: wasEnabled }, { persist: false, syncSkill: false }); await cleanup(profile); }
  });

  await test("8. when-guards compose if/else inside one chain", async () => {
    const profile = `oneshot-8-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/banner` },
        { op: "click", label: "Upgrade", when: { textNot: "Premium active" } },
        { op: "click", label: "Continue", when: { text: "Premium active" } },
        { op: "search", pattern: "Premium active" }
      ]);
      assert.equal(res.ok, true, JSON.stringify(res.results?.filter((r) => !r.ok)));
      assert.equal(res.results[1].skipped, true, "upgrade branch skipped");
      assert.equal(res.results[2].skipped, undefined, "continue branch ran");
      assert.notEqual(res.state.title, "UPGRADED", "wrong branch never fired");
    } finally { await cleanup(profile); }
  });

  await test("9. text for=N waits for slow evidence instead of failing", async () => {
    const profile = `oneshot-9-${stamp}`;
    try {
      const impatient = await chain(profile, [
        { op: "go", url: `${base}/late` },
        { op: "search", pattern: "SLOW-PAYLOAD-READY" }
      ]);
      assert.equal(impatient.ok, false, "without for, the read fails past self-heal");
      assert.equal(impatient.failedStep, 2);

      const patient = await chain(profile, [
        { op: "go", url: `${base}/late` },
        { op: "search", pattern: "SLOW-PAYLOAD-READY", for: 6000 }
      ]);
      assert.equal(patient.ok, true, JSON.stringify(patient.results?.filter((r) => !r.ok)));
      assert.ok(patient.results[1].matched >= 1, "for= waited until the text landed");
    } finally { await cleanup(profile); }
  });

  await test("10. twelve-step wizard still lands in ONE shot", async () => {
    const profile = `oneshot-10-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/wizard` },
        { op: "type", label: "Project name", text: "app" },
        { op: "select", label: "pro" },
        { op: "click", label: "Next" },
        { op: "type", label: "API key", text: "sk-1" },
        { op: "click", label: "Next" },
        { op: "select", label: "team" },
        { op: "click", label: "Next" },
        { op: "click", label: "Finish" },
        { op: "search", pattern: "Wizard complete" },
        { op: "find", pattern: "certificate" },
        { op: "shot" }
      ]);
      assert.equal(res.ok, true, JSON.stringify(res.results?.filter((r) => !r.ok)));
      assert.equal(res.results.length, 12, "12 steps, one shot");
      assert.ok(res.results.find((r) => r.op === "shot").path, "final frame saved");
    } finally { await cleanup(profile); }
  });

  await test("11. tight rules: --goal anchors the break, 1-step chains and owed steps get called out", async () => {
    const profile = `oneshot-11-${stamp}`;
    try {
      // Break WITH a goal: the response echoes the destination + progress.
      const broke = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "click", label: "Definitely Not Here" },
        { op: "search", pattern: "Dashboard" }
      ], { goal: "reach the dashboard" });
      assert.equal(broke.ok, false);
      assert.equal(broke.goal, "reach the dashboard");
      assert.equal(broke.progress, "2/3", "progress names how far the journey got");

      // The very next chain is reminded of the owed steps, once.
      const reminded = await chain(profile, [{ op: "search", pattern: "Sign in" }]);
      assert.match(reminded.note ?? "", /owing.*search/, "debt reminder fires on the next chain");
      const after = await chain(profile, [{ op: "search", pattern: "Sign in" }]);
      assert.doesNotMatch(after.note ?? "", /owing/, "reminder fires once, then clears");

      // A lone action step is a single verb in chain clothing.
      const solo = await chain(`oneshot-11b-${stamp}`, [{ op: "go", url: `${base}/app` }]);
      assert.match(solo.note ?? "", /WHOLE journey/, "1-step action chain gets called out");
      await cleanup(`oneshot-11b-${stamp}`);
    } finally { await cleanup(profile); }
  });

  await test("12. guards catch REAL misses only: declared submits and nav:true links do not false-break", async () => {
    // type + enter:true is a DECLARED submission — the chain must follow the
    // form onto the results page, not die on "unexpected navigation".
    const profile = `oneshot-12-${stamp}`;
    try {
      const typed = await chain(profile, [
        { op: "go", url: `${base}/search` },
        { op: "type", label: "Search", text: "hello", enter: true },
        { op: "click", label: "Next result" },
        { op: "search", pattern: "Results for hello" }
      ]);
      assert.equal(typed.ok, true, JSON.stringify(typed.results?.filter((r) => !r.ok)));
      assert.equal(typed.state.title, "NEXT-CLICKED", "steps ran on the POST-SUBMIT page");
    } finally { await cleanup(profile); }

    // A link the model declares as navigation (nav:true) adopts its landing
    // page; WITHOUT the flag the same click still fails — the guard keeps
    // catching genuinely undeclared moves.
    const hubProfile = `oneshot-12b-${stamp}`;
    try {
      const declared = await chain(hubProfile, [
        { op: "go", url: `${base}/hub` },
        { op: "click", label: "Open report", nav: true },
        { op: "search", pattern: "Results for" }
      ]);
      assert.equal(declared.ok, true, JSON.stringify(declared.results?.filter((r) => !r.ok)));
    } finally { await cleanup(hubProfile); }
    const hubProfile2 = `oneshot-12c-${stamp}`;
    try {
      const undeclared = await chain(hubProfile2, [
        { op: "go", url: `${base}/hub` },
        { op: "click", label: "Open report" },
        { op: "hover", label: "Next result" } // action step — runs INTO the nav guard
      ]);
      assert.equal(undeclared.ok, false, "undeclared navigation still breaks the next ACTION step");
      assert.match(undeclared.results.find((r) => !r.ok).error, /unexpected navigation/);
    } finally { await cleanup(hubProfile2); }
  });

  await test("13. evidence beats confidence: passing expectText survives a low-confidence delegate", async () => {
    const profile = `oneshot-13-${stamp}`;
    const wasEnabled = (await invoke("config.get")).config.enabled;
    setConfig({ enabled: true }, { persist: false, syncSkill: false });
    // Do the real work confidently, then declare DONE SHAKILY — the loop ends
    // low_confidence even though every action landed on the page.
    const calls = [];
    const shakyDoneDecide = async ({ questions }) => {
      const mk = (criteria, choice, confidence) => {
        const probabilities = {}; for (const k of Object.keys(criteria)) probabilities[k] = k === choice ? 1 : 0;
        return { choice, confidence, probabilities };
      };
      const answer = (question, want) => {
        const hit = Object.entries(question.criteria).find(([, v]) =>
          want.test(typeof v === "string" ? v : JSON.stringify(v)));
        return hit ? mk(question.criteria, hit[0], 1) : null;
      };
      calls.push(1);
      const type = questions.type_text_target;
      if (type && calls.length <= 2) {
        const target = answer(type, calls.length === 1 ? /email/i : /password/i);
        if (target) return { answers: { operation: mk(questions.operation.criteria, "TYPE_TEXT", 1), type_text_target: target } };
      }
      const click = questions.click_target;
      const clickAnswer = click ? answer(click, /sign in/i) : null;
      if (clickAnswer) return { answers: { operation: mk(questions.operation.criteria, "CLICK", 1), click_target: clickAnswer } };
      return { answers: { operation: mk(questions.operation.criteria, "DONE", 0.3) } };
    };
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/app` },
        { op: "run", goal: "Sign in with the provided credentials",
          fields: { Email: "me@x.co", Password: "hunter2" }, expectText: ["Dashboard"] },
        { op: "search", pattern: "Dashboard" }
      ], { decide: shakyDoneDecide });
      assert.equal(res.ok, true, `low-confidence finish voided a landed journey: ${JSON.stringify(res.results?.filter((r) => !r.ok))}`);
      assert.ok(res.results.find((r) => r.op === "search").matched >= 1, "chain continued on the post-sign-in page");
    } finally { setConfig({ enabled: wasEnabled }, { persist: false, syncSkill: false }); await cleanup(profile); }
  });

  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
