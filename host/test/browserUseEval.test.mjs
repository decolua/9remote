// TDD eval suite: easy / hard / login-popup journeys + baseline metrics.
// RED until `run --fields` lands: matching fills become TYPE_TEXT targets whose
// text the AGENT provided (never generated); password fields are observable but
// value-masked at the snapshot source. Run: node host/test/browserUseEval.test.mjs
import assert from "node:assert/strict";
import "./chromeGuard.mjs";
import fs from "node:fs";
import http from "node:http";

let pass = 0, fail = 0;
const test = async (name, fn) => {
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

if (!hasChrome) {
  console.log("  - skipped (no Chrome binary found)");
} else {
  const engine = await import("../features/browserUse/engine.js");
  const { withSession, observe, closeProfile, profiles } = engine;
  const { runAutoContinue } = await import("../features/browserUse/browserUseSocket.js");

  const PAGES = {
    "/easy": `<!doctype html><html><body>
      <input id="q" placeholder="Query">
      <button onclick="document.getElementById('out').textContent='DONE:'+document.getElementById('q').value">Search</button>
      <div id="out"></div>
    </body></html>`,
    "/hard": `<!doctype html><html><body>
      <button onclick="document.getElementById('form').style.display='block'">Go phase two</button>
      <div id="form" style="display:none">
        <input id="city" placeholder="City" oninput="clearTimeout(this.t);this.t=setTimeout(()=>{document.getElementById('sug').style.display='block'},300)">
        <div id="sug" style="display:none"><button type="button">Zürich Airport</button></div>
        <input id="email" placeholder="Email">
        <button onclick="document.getElementById('out').textContent='PHASE OK '+document.getElementById('city').value+' '+document.getElementById('email').value">Finish</button>
      </div>
      <div id="out"></div>
    </body></html>`,
    "/login": `<!doctype html><html><body>
      <button id="open" onclick="document.getElementById('modal').style.display='flex'">Open settings</button>
      <button id="under" onclick="document.title='NOPE'">Do it now</button>
      <div id="modal" role="dialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5)">
        <div style="background:#fff;margin:100px auto 0;width:300px;padding:20px">
          <h2>Sign in</h2>
          <input id="email" placeholder="Email">
          <input id="pw" type="password" placeholder="Password">
          <button onclick="if(document.getElementById('pw').value==='s3cret!'){document.getElementById('modal').style.display='none';document.getElementById('out').textContent='WELCOME '+document.getElementById('email').value}else{document.getElementById('err').textContent='Wrong password'}">Log in</button>
          <div id="err"></div>
        </div>
      </div>
      <div id="out"></div>
    </body></html>`,
    "/shadow": `<!doctype html><html><body>
      <div id="host"><span>Shadow button via slot</span></div><div id="out"></div>
      <button onclick="document.getElementById('out').textContent='LIGHT-CLICKED'">Light button</button>
      <script>
        const s=document.getElementById('host').attachShadow({mode:'open'});
        s.innerHTML='<label>Shadow email <input placeholder="Shadow email"></label>'+
          '<button onclick="document.getElementById(\\'out\\').textContent=\\'SHADOW-CLICKED\\'"><slot></slot></button>';
      <\/script>
    </body></html>`,
    "/dense": `<!doctype html><html><body>${'<button style="font-size:6px;height:6px;padding:0">Item</button>'.repeat(400)}<div style="height:2000px"></div></body></html>`
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGES[new URL(req.url, "http://x").pathname] ?? PAGES["/easy"]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = `eval-${Date.now()}`;
  const open = (path) => withSession({ profile, url: base + path, headless: true }, (s) => s);

  // Calibrated fake-Jev answer builders (same recipe as browserUseCases).
  const opOf = (questions, choice) => ({
    choice, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(questions.operation.criteria).map((k) => [k, k === choice ? 1 : 0]))
  });
  const tgt = (criteria, idx) => ({
    choice: idx, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === idx ? 1 : 0]))
  });

  // Scripted decide: one instruction per model call; fails with a clear contract
  // message when the expected question/head is missing (that is the RED signal).
  const scriptDecide = (instructions, bodies = null) => {
    let i = 0;
    return async (body) => {
      bodies?.push(body);
      const step = instructions[i++];
      if (!step) return { answers: { operation: opOf(body.questions, "DONE") }, model: "fake" };
      if (step.op === "CLICK") {
        const criteria = body.questions.click_target?.criteria || {};
        const key = Object.keys(criteria).find((k) => step.re.test(criteria[k].element || ""));
        if (!key) throw new Error(`scripted CLICK not offered: ${step.re}`);
        return { answers: { operation: opOf(body.questions, "CLICK"), click_target: tgt(criteria, key) }, model: "fake" };
      }
      if (step.op === "TYPE_TEXT") {
        const criteria = body.questions.type_text_target?.criteria;
        if (!criteria) throw new Error("fields contract: type_text_target question missing — fills are never offered to Jev");
        const key = Object.keys(criteria).find((k) => step.re.test(criteria[k].element || ""));
        if (!key) throw new Error(`fields contract: no fill target matches ${step.re}`);
        return { answers: { operation: opOf(body.questions, "TYPE_TEXT"), type_text_target: tgt(criteria, key) }, model: "fake" };
      }
      if (step.op === "WAIT") return { answers: { operation: opOf(body.questions, "WAIT") }, model: "fake" };
      throw new Error(`unknown script op: ${step.op}`);
    };
  };

  console.log("browserUse eval (easy / hard / login-popup)...");

  await test("easy: one field + submit driven end-to-end by fields", async () => {
    const s = await open("/easy");
    const { result, verification } = await runAutoContinue(s, {
      goal: "Search for hello world",
      fields: { "Query": "hello world" },
      decide: scriptDecide([
        { op: "TYPE_TEXT", re: /query/i },
        { op: "CLICK", re: /search/i }
      ]),
      expect: { text: ["DONE:hello world"] },
      maxSteps: 6, maxMs: 30000
    });
    assert.equal(result.outcome, "needs_verification", result.reason);
    assert.equal(verification.passed, true, JSON.stringify(verification.checks));
    assert.ok(result.metrics.modelCalls <= 4, "easy case must not burn model calls");
  });

  await test("hard: two-phase reveal, two fields, 300ms autocomplete settles", async () => {
    const s = await open("/hard");
    const bodies = [];
    const { result, verification } = await runAutoContinue(s, {
      goal: "Fill the phase-two form and finish",
      fields: { "City": "Zürich", "Email": "a@b.c" },
      decide: scriptDecide([
        { op: "CLICK", re: /go phase two/i },
        { op: "TYPE_TEXT", re: /city/i },
        { op: "TYPE_TEXT", re: /email/i },
        { op: "CLICK", re: /finish/i }
      ], bodies),
      expect: { text: ["PHASE OK Zürich a@b.c"] },
      maxSteps: 8, maxMs: 30000
    });
    assert.equal(result.outcome, "needs_verification", result.reason);
    assert.equal(verification.passed, true, JSON.stringify(verification.checks));
    // bodies[2] is the decision AFTER typing City — settle must have captured
    // the suggestion that lands 300ms after the keystroke.
    assert.ok(bodies[2] && JSON.stringify(bodies[2]).includes("Zürich Airport"),
      "late autocomplete captured before the next decision");
  });

  await test("login popup: covered click refused, password masked, flow completes", async () => {
    const s = await open("/login");
    const bodies = [];
    const { result, verification } = await runAutoContinue(s, {
      goal: "Open settings and sign in",
      fields: { "Email": "a@b.c", "Password": "s3cret!" },
      decide: scriptDecide([
        { op: "CLICK", re: /open settings/i },
        { op: "CLICK", re: /do it now/i },   // covered by the modal — must go STALE
        { op: "TYPE_TEXT", re: /email/i },
        { op: "TYPE_TEXT", re: /password/i },
        { op: "CLICK", re: /log in/i }
      ], bodies),
      expect: { text: ["WELCOME a@b.c"] },
      maxSteps: 10, maxMs: 40000
    });
    assert.equal(result.outcome, "needs_verification", result.reason);
    assert.equal(verification.passed, true, JSON.stringify(verification.checks));
    assert.ok(result.steps.some((st) => st.result === "stale"), "click under the modal overlay was refused");
    const pwCriteria = bodies.flatMap((b) => Object.values(b.questions.type_text_target?.criteria || {})
      .filter((c) => /password/i.test(c.element || "")));
    assert.ok(pwCriteria.length, "password field offered as a TYPE target");
    assert.ok(pwCriteria.every((c) => ["", "••••"].includes(c.current_value ?? "")),
      "password shows only empty-or-filled bullets, never the value");
    assert.ok(!bodies.some((b) => JSON.stringify(b).includes("s3cret!")), "the secret never enters any prompt");
  });

  await test("shadow DOM: buttons and fields inside shadow roots are visible and clickable", async () => {
    const s = await open("/shadow");
    const state = await s.observe();
    const shadowBtn = state.actions.find((a) => /shadow button/i.test(a.label));
    const shadowFill = state.actions.find((a) => a.kind === "fill" && /shadow email/i.test(a.label));
    const lightBtn = state.actions.find((a) => a.label === "Light button");
    assert.ok(shadowBtn && shadowFill && lightBtn, `shadow content observed: ${!!shadowBtn}/${!!shadowFill}, light: ${!!lightBtn}`);
    await s.act(shadowBtn);
    assert.ok((await s.current()).text.includes("SHADOW-CLICKED"), "shadow button click landed");
    await s.act(shadowFill, "typed into shadow");
    assert.ok((await s.current()).actions.some((a) => a.kind === "fill" && a.value === "typed into shadow"),
      "shadow field fill landed");
  });

  await test("baseline metrics (informational — compare before/after optimizations)", async () => {
    const s = await open("/dense");
    const t0 = Date.now();
    await s.observe();
    const coldMs = Date.now() - t0;
    let warm = 0;
    for (let i = 0; i < 3; i++) { const t = Date.now(); await s.observe(); warm += Date.now() - t; }
    const btn = (await s.current()).actions.find((a) => a.label === "Item");
    const t1 = Date.now();
    await s.act(btn);
    const settleMs = Date.now() - t1;
    console.log(`  [baseline] dense page (400 buttons): observe cold=${coldMs}ms warm=${Math.round(warm / 3)}ms · no-change click+settle=${settleMs}ms`);
    assert.ok(coldMs > 0 && settleMs > 0);
  });

  await closeProfile(profile).catch(() => {});
  await profiles.remove(profile).catch(() => {});
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
