// TDD hard-case suite — 10 tricky pages, real Chrome headless, fake Jev (offline).
// No login, no network: every page is a local fixture served in-process.
// Run: node host/test/browserUseCases.test.mjs
import assert from "node:assert/strict";
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
  const { withSession, observe, runTask, typeById, closeProfile, deleteProfile } = engine;

  const PAGES = {
    "/": `<!doctype html><html><body style="margin:0">
      <div id="x" onclick="document.title='DIV-CLICKED'" style="padding:10px;background:#eee">Do it now</div>
      <div id="subs">
        <button onclick="document.title='S1'">Submit</button>
        <button onclick="document.title='S2'">Submit</button>
        <button onclick="document.title='S3'">Submit</button>
      </div>
      <div style="position:relative;height:40px">
        <button onclick="document.title='NOPE'">Hidden goal</button>
        <div style="position:absolute;inset:0;background:#ccc;opacity:.5"></div>
      </div>
      <select onchange="document.title='SEL:'+this.value">
        <option value="">Choose</option><option value="a">Alpha</option><option value="b">Beta</option>
      </select>
      <div contenteditable="true" oninput="document.title='CE'">Notes here</div>
      <a href="/slow">Go slow page</a>
    </body></html>`,
    "/slow": `<!doctype html><html><body>
      <button id="late" style="display:none" onclick="document.title='REVEALED'">Reveal target</button>
      <script>setTimeout(()=>{document.getElementById('late').style.display='block'},600)<\/script>
    </body></html>`,
    "/shift": `<!doctype html><html><body>
      <div id="zone"><button onclick="document.title='OLD'">Original</button></div>
      <script>setTimeout(()=>{document.getElementById('zone').innerHTML='<button onclick="document.title=\\'NEW\\'">Original</button>'},500)<\/script>
    </body></html>`,
    "/header": `<!doctype html><html><body style="margin:0">
      <div style="position:fixed;top:0;left:0;right:0;height:60px;background:#fff;z-index:9">Header</div>
      <button style="position:absolute;top:10px" onclick="document.title='COVERED'">Under header</button>
      <button style="position:absolute;top:200px" onclick="document.title='VISIBLE'">Below header</button>
    </body></html>`,
    "/long": `<!doctype html><html><body>${'<button style="font-size:6px;height:6px;padding:0">Item</button>'.repeat(400)}<div style="height:2000px"></div></body></html>`,
    "/frame": `<!doctype html><html><body>
      <iframe src="/frame-child" style="width:300px;height:100px"></iframe>
      <button onclick="document.title='OUT'">Outside frame</button>
    </body></html>`,
    "/noisy": `<!doctype html><html><body>
      <nav><a href="#">Trang chủ</a> <a href="#">Liên hệ</a></nav>
      <div class="cookie-banner">Accept all cookies?</div>
      <article><h2>Bài viết</h2><p>Nội dung chính của bài viết nằm ở đây, đoạn văn thật sự có ý nghĩa.</p></article>
      <div class="ad">Mua ngay giảm giá 50%</div>
      <button onclick="document.title='x'">Quyên góp</button>
      <footer><a href="#">Điều khoản</a> Bảo mật</footer>
    </body></html>`,
    "/spa": `<!doctype html><html><body>
      <a href="/spa2" id="go">Go SPA</a>
      <div id="app"></div>
      <script>
        document.getElementById('go').addEventListener('click', (e) => {
          e.preventDefault(); history.pushState({}, '', '/spa2');
          setTimeout(() => {
            const app = document.getElementById('app');
            app.innerHTML = '<button id="b">Loaded Two</button>';
            document.getElementById('b').addEventListener('click', () => { document.title = 'SPA2'; });
          }, 800);
        });
      <\/script>
    </body></html>`,
    "/tallstatic": `<!doctype html><html><body>
      <button style="position:fixed;top:10px" onclick="document.title='A'">Anchor</button>
      <div style="height:5000px"></div>
    </body></html>`,
    "/twophase": `<!doctype html><html><body>
      <button onclick="document.getElementById('f').style.display='block'">Go phase two</button>
      <button id="f" style="display:none" onclick="document.getElementById('out').textContent='PHASE DONE'">Finish it</button>
      <div id="out"></div>
    </body></html>`,
    "/sections": `<!doctype html><html><body>
      <fieldset><legend>Shipping</legend><button onclick="document.title='SHIP'">OK</button></fieldset>
      <fieldset><legend>Billing</legend><button onclick="document.title='BILL'">OK</button></fieldset>
    </body></html>`,
    "/latecontent": `<!doctype html><html><body>
      <button onclick="document.title='CLK';setTimeout(()=>{document.getElementById('out').textContent='LOADED'},300)">Load it</button>
      <div id="out"></div>
    </body></html>`,
    "/hydrate": `<!doctype html><html><body><script>
      setTimeout(()=>{document.body.innerHTML='<button onclick="document.title=\\'H\\'">Hidden until hydrated</button>'},250)
    <\/script></body></html>`,
    "/frame-child": `<!doctype html><html><body>
      <button onclick="parent.document.title='IN'">Inside frame</button>
    </body></html>`
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGES[req.url] ?? PAGES["/"]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = `hardcase-${Date.now()}`;
  const open = (path) => withSession({ profile, url: base + path, headless: true }, (s) => s);

  // Fake Jev helpers: calibrated answers built from the actual criteria keys.
  const op = (questions, choice) => ({
    choice, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(questions.operation.criteria).map((k) => [k, k === choice ? 1 : 0]))
  });
  const target = (criteria, idx) => ({
    choice: idx, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === idx ? 1 : 0]))
  });

  console.log("browserUse hard cases (real Chrome, fake Jev)...");

  await test("1. untyped div[onclick] is clickable (SPA button)", async () => {
    const s = await open("/");
    let done = false;
    const decide = ({ questions }) => {
      const criteria = questions.click_target?.criteria || {};
      const found = done ? null : Object.keys(criteria).find((k) => /do it now/i.test(criteria[k].element || ""));
      if (found) {
        done = true;
        return Promise.resolve({ answers: { operation: op(questions, "CLICK"), click_target: target(criteria, found) }, model: "fake" });
      }
      return Promise.resolve({ answers: { operation: op(questions, done ? "DONE" : "BLOCKED") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "Click the 'Do it now' control", decide, maxSteps: 4, maxMs: 15000 });
    assert.equal(result.outcome, "needs_verification");
    assert.equal((await observe(s)).title, "DIV-CLICKED");
  });

  await test("2. three identical 'Submit' labels map to distinct nodes", async () => {
    const s = await open("/");
    let done = false;
    const decide = ({ questions }) => {
      const criteria = questions.click_target?.criteria || {};
      const keys = Object.keys(criteria)
        .filter((k) => /Submit/.test(criteria[k].element || ""))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      if (keys.length >= 2 && !done) {
        done = true;
        return Promise.resolve({ answers: { operation: op(questions, "CLICK"), click_target: target(criteria, keys[1]) }, model: "fake" });
      }
      return Promise.resolve({ answers: { operation: op(questions, done ? "DONE" : "BLOCKED") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "Click the second Submit", decide, maxSteps: 4, maxMs: 15000 });
    assert.equal(result.outcome, "needs_verification");
    const step = result.steps.find((st) => st.result === "ok");
    assert.equal(step.label, "Submit (2)");
    assert.equal((await observe(s)).title, "S2");
  });

  await test("3. covered button refuses the click (overlay)", async () => {
    const s = await open("/");
    const action = (await observe(s)).actions.find((a) => /hidden goal/i.test(a.label));
    assert.ok(action, "covered button IS observed");
    await assert.rejects(() => s.act(action), (e) => e.code === "STALE");
  });

  await test("4. node replaced between observe and click goes STALE, never clicks blind", async () => {
    const s = await open("/shift");
    const action = (await observe(s)).actions.find((a) => a.label === "Original");
    assert.ok(action);
    await new Promise((r) => setTimeout(r, 700));
    await assert.rejects(() => s.act(action), (e) => e.code === "STALE");
  });

  await test("5. button revealed after 600ms — WAIT survives, no false no-progress", async () => {
    const s = await open("/slow");
    let done = false;
    const decide = ({ questions }) => {
      const criteria = questions.click_target?.criteria || {};
      const found = done ? null : Object.keys(criteria).find((k) => /reveal target/i.test(criteria[k].element || ""));
      if (found) {
        done = true;
        return Promise.resolve({ answers: { operation: op(questions, "CLICK"), click_target: target(criteria, found) }, model: "fake" });
      }
      return Promise.resolve({ answers: { operation: op(questions, done ? "DONE" : "WAIT") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "Click the reveal target", decide, maxSteps: 12, maxMs: 30000 });
    assert.equal(result.outcome, "needs_verification");
    // Either Jev WAITed for the reveal, or observe's hydration grace already
    // saw the button — both are correct; a false no_progress is not.
    assert.ok(!["no_progress", "blocked"].includes(result.outcome));
    assert.equal((await observe(s)).title, "REVEALED");
  });

  await test("6. fixed header covering a button: covered one refused, visible one works", async () => {
    const s = await open("/header");
    const state = await observe(s);
    const covered = state.actions.find((a) => a.label === "Under header");
    const visible = state.actions.find((a) => a.label === "Below header");
    assert.ok(covered && visible);
    await assert.rejects(() => s.act(covered), (e) => e.code === "STALE");
    await s.act(visible);
    assert.equal((await observe(s)).title, "VISIBLE");
  });

  await test("7. 400 buttons: element cap + omitted_actions + scroll offered", async () => {
    const s = await open("/long");
    const state = await observe(s);
    assert.ok(state.actions.filter((a) => a.kind === "click").length <= 250, "cap holds");
    assert.ok(state.omitted_actions > 100, "omissions reported");
    assert.ok(state.actions.some((a) => a.id === "scroll_down"), "scroll offered");
  });

  await test("8. native select: Jev picks the right option", async () => {
    const s = await open("/");
    let done = false;
    const decide = ({ questions }) => {
      const criteria = questions.select_target?.criteria || {};
      const found = done ? null : Object.keys(criteria).find((k) => /→ Beta/.test(criteria[k].element || ""));
      if (found) {
        done = true;
        return Promise.resolve({ answers: { operation: op(questions, "SELECT"), select_target: target(criteria, found) }, model: "fake" });
      }
      return Promise.resolve({ answers: { operation: op(questions, done ? "DONE" : "BLOCKED") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "Choose Beta", decide, maxSteps: 4, maxMs: 15000 });
    assert.equal(result.outcome, "needs_verification");
    assert.equal((await observe(s)).title, "SEL:b");
  });

  await test("9. contenteditable: fill excluded from Jev, click-variant + typeById work", async () => {
    const s = await open("/");
    const state = await observe(s);
    const fill = state.actions.find((a) => a.kind === "fill" && /notes here/i.test(a.label));
    const openVariant = state.actions.find((a) => a.kind === "click" && /open notes here/i.test(a.label));
    assert.ok(fill && openVariant, "both fill and Open variant observed");
    await typeById(s, fill.id, "typed by agent");
    assert.ok((await observe(s)).text.includes("typed by agent"), "text landed");
  });

  await test("10. iframe: top-frame snapshot only — frame content is a known gap", async () => {
    const s = await open("/frame");
    const state = await observe(s);
    assert.ok(state.actions.some((a) => a.label === "Outside frame"), "top frame seen");
    // Known gap (orca solves it with per-frame AX sessions): elements inside the
    // iframe are invisible to the top-document snapshot. Upgrade: per-frame CDP.
    assert.ok(!state.actions.some((a) => a.label === "Inside frame"), "frame gap documented");
  });

  await test("11. invoke('click') returns the post-action state in one round trip", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/");
    const action = (await observe(s)).actions.find((a) => /do it now/i.test(a.label));
    const res = await invoke("click", { profile, id: action.id });
    assert.ok(res.ok && res.state?.actions, "state returned with the action");
    assert.equal(res.state.title, "DIV-CLICKED");
    const cached = await invoke("state", { profile });
    assert.equal(cached.title, "DIV-CLICKED", "state action agrees (cached path)");
  });

  await test("12. run with only-pattern narrows the action space", async () => {
    const s = await open("/");
    let done = false;
    let leakSeen = false;
    const decide = ({ questions }) => {
      const criteria = questions.click_target?.criteria || {};
      // Any non-Submit element offered means the only-filter failed.
      if (Object.values(criteria).some((v) => !/Submit/.test(v.element || ""))) leakSeen = true;
      const keys = Object.keys(criteria);
      if (keys.length && !done) {
        done = true;
        return Promise.resolve({ answers: { operation: op(questions, "CLICK"), click_target: target(criteria, keys[0]) }, model: "fake" });
      }
      return Promise.resolve({ answers: { operation: op(questions, done ? "DONE" : "BLOCKED") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "Click the first Submit", decide, only: "Submit", maxSteps: 4, maxMs: 15000 });
    assert.ok(!leakSeen, "only non-Submit elements leaked into the space");
    assert.equal(result.outcome, "needs_verification");
    assert.equal((await observe(s)).title, "S1");
  });

  await test("13. chain runs several steps in one call and returns the final table", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/");
    const before = await observe(await open("/"));
    const divBtn = before.actions.find((a) => /do it now/i.test(a.label));
    const beta = before.actions.find((a) => a.kind === "select" && a.value === "b");
    const notes = before.actions.find((a) => a.kind === "fill" && /notes here/i.test(a.label));
    const res = await invoke("chain", { profile, steps: [
      { op: "click", id: divBtn.id },
      { op: "select", id: beta.id },
      { op: "type", id: notes.id, text: "chain works" },
      { op: "wait", text: "chain works" }
    ] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal(res.results.length, 4);
    assert.ok(res.results.every((r) => r.ok));
    assert.ok(res.state.text.includes("chain works"), "final state returned");
  });

  await test("14. chain stops at the first failing step with live state", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/");
    const divBtn = (await observe(s)).actions.find((a) => /do it now/i.test(a.label));
    const res = await invoke("chain", { profile, steps: [
      { op: "click", id: divBtn.id },
      { op: "click", id: "e999" }
    ] });
    assert.ok(!res.ok);
    assert.equal(res.failedStep, 2);
    assert.ok(res.results[0].ok && !res.results[1].ok);
    assert.equal(res.state.title, "DIV-CLICKED", "state shows step 1 landed");
  });

  await test("15. re-opening the original URL returns after navigating away", async () => {
    const s = await open("/");
    const link = (await observe(s)).actions.find((a) => /go slow page/i.test(a.label));
    await s.act(link);
    assert.equal((await observe(s)).url, `${base}/slow`);
    const back = await open("/"); // same URL as the first open — must navigate again
    assert.equal((await observe(back)).url, `${base}/`);
  });

  await test("16. run.cancel stops the loop at the next decision boundary", async () => {
    const s = await open("/");
    const decide = ({ questions }) => {
      s.cancelRequested = true; // as if the user pressed stop mid-run
      const criteria = questions.click_target?.criteria || {};
      const keys = Object.keys(criteria);
      return Promise.resolve(keys.length
        ? { answers: { operation: op(questions, "CLICK"), click_target: target(criteria, keys[0]) }, model: "fake" }
        : { answers: { operation: op(questions, "DONE") }, model: "fake" });
    };
    const result = await runTask(s, { goal: "click then get cancelled", decide, maxSteps: 6, maxMs: 15000 });
    assert.equal(result.outcome, "cancelled");
    assert.ok(result.steps.length <= 2, "stopped right after the in-flight step");
    // A cancelled run must not poison the next one.
    const next = await runTask(s, { goal: "fresh run", decide: async ({ questions }) =>
      ({ answers: { operation: op(questions, "DONE") }, model: "fake" }), maxSteps: 2, maxMs: 10000 });
    assert.equal(next.outcome, "needs_verification", "flag was reset for the next run");
  });

  await test("17. run.cancel also breaks a running chain at the next step", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const { requestCancel } = await import("../features/browserUse/engine.js");
    await open("/");
    requestCancel(profile); // user pressed stop right before the chain ran
    const res = await invoke("chain", { profile, steps: [{ op: "enter" }, { op: "enter" }] });
    assert.ok(!res.ok && res.failedStep === 1 && res.results[0].error === "cancelled");
    const after = await invoke("chain", { profile, steps: [{ op: "enter" }] });
    assert.ok(after.ok, "a fresh chain is not poisoned by the old cancel");
  });

  await test("18. checkExpectations verifies url/title/text independently (fbu pattern)", async () => {
    const { checkExpectations } = await import("../features/browserUse/browserUseSocket.js");
    const facts = { url: "https://x/y", title: "Saved", text: "Timezone: Asia/Singapore.\nWeekly digest: enabled." };
    const pass = checkExpectations(facts, { title: "Saved", text: ["Timezone: Asia/Singapore.", "Weekly digest: enabled."] });
    assert.equal(pass.passed, true);
    const fail = checkExpectations(facts, { url: "https://x/z", text: ["Timezone: Europe/Paris."] });
    assert.equal(fail.passed, false);
    assert.deepEqual(fail.checks, { url: false, text_1: false });
  });

  await test("19. post-action settle waits for late content (quiet window)", async () => {
    const s = await open("/latecontent");
    const btn = (await observe(s)).actions.find((a) => /load it/i.test(a.label));
    await s.act(btn);
    assert.ok((await s.current()).text.includes("LOADED"), "late content captured by the settle window");
  });

  await test("20. observe retries through a blank hydrating page", async () => {
    const s = await open("/hydrate");
    const state = await observe(s);
    const btn = state.actions.find((a) => /hidden until hydrated/i.test(a.label));
    assert.ok(btn, "hydrated button observed, not a blank table");
    await s.act(btn);
    assert.equal((await observe(s)).title, "H");
  });

  await test("21. criteria labels are capped and duplicates get (n) suffixes", async () => {
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const long = "A".repeat(120);
    const actions = [
      { id: "e1", kind: "click", label: long, role: "button", value: "", node: 1 },
      { id: "e2", kind: "click", label: "Submit", role: "button", value: "", node: 2 },
      { id: "e3", kind: "click", label: "Submit", role: "button", value: "", node: 3 },
      { id: "wait", kind: "wait", label: "Wait" }
    ];
    const space = buildActionSpace(actions);
    const body = buildQuestions({ url: "https://x", title: "t", text: "", actions }, "pick", [], space);
    const criteria = body.questions.click_target.criteria;
    assert.ok(criteria.e1.element.length <= 90, "long label capped");
    assert.match(criteria.e2.element, /\[e2\] Submit$/);
    assert.match(criteria.e3.element, /\[e3\] Submit \(2\)$/);
    assert.equal(space.targets.CLICK.e3.node, 3, "labeled copy still references the real node");
  });

  await test("22. expect-text also matches filled field values, not just body text", async () => {
    const { checkExpectations } = await import("../features/browserUse/browserUseSocket.js");
    const state = {
      url: "https://f/post", title: "Form", text: "",
      actions: [
        { kind: "fill", label: "Customer name", value: "Nguyen Van A" },
        { kind: "click", label: "Submit", value: "" }
      ]
    };
    const pass = checkExpectations(state, { text: ["Nguyen Van A", "Customer name"] });
    assert.equal(pass.passed, true);
    const fail = checkExpectations(state, { text: ["Khung này trống"] });
    assert.equal(fail.passed, false);
  });

  await test("23. --only matching 0 elements fails fast with guidance", async () => {
    const s = await open("/");
    await assert.rejects(
      () => runTask(s, { goal: "go", only: "ZZZNOPE", maxSteps: 2, maxMs: 5000 }),
      /matched 0 elements.*never offered/
    );
  });

  await test("24. a dead tab self-heals on the next command", async () => {
    const { withSession } = engine;
    let ref = null;
    const st1 = await withSession({ profile, url: `${base}/`, headless: true },
      (s) => { ref = s; return s.observe(); });
    assert.ok(st1.actions.length);
    // Kill the target while the browser WS stays alive (user closed the tab).
    await ref.client.call("Target.closeTarget", { targetId: ref.targetId });
    const st2 = await withSession({ profile, url: `${base}/`, headless: true },
      (s) => s.observe());
    assert.ok(st2.actions.length > 0, "session relaunched instead of wedging");
  });

  await test("25. criteria carry control state (checked/expanded)", async () => {
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const actions = [
      { id: "e1", kind: "click", label: "Bacon", role: "checkbox", value: "", node: 1, checked: "true" },
      { id: "e2", kind: "click", label: "More options", role: "button", value: "", node: 2, expanded: "false" },
      { id: "wait", kind: "wait", label: "Wait" }
    ];
    const space = buildActionSpace(actions);
    const body = buildQuestions({ url: "https://x", title: "t", text: "", actions }, "g", [], space);
    assert.equal(body.questions.click_target.criteria.e1.state, "checked");
    assert.equal(body.questions.click_target.criteria.e2.state, "collapsed");
  });

  await test("26. same-label buttons in different sections are told apart by context", async () => {
    const s = await open("/sections");
    const state = await observe(s);
    const oks = state.actions.filter((a) => a.label === "OK");
    assert.equal(oks.length, 2);
    assert.deepEqual(new Set(oks.map((a) => a.ctx)), new Set(["Shipping", "Billing"]));
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const space = buildActionSpace(state.actions);
    const body = buildQuestions(state, "g", [], space);
    const els = Object.values(body.questions.click_target.criteria)
      .filter((c) => /\bOK\b/.test(c.element)).map((c) => c.element);
    assert.ok(els.some((e) => e.includes("Shipping")) && els.some((e) => e.includes("Billing")));
  });

  await test("27. page state carries headings, scroll position and omissions", async () => {
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const actions = [
      { id: "e1", kind: "click", label: "Go", role: "button", value: "", node: 1 },
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
      { id: "wait", kind: "wait", label: "Wait" }
    ];
    const page = {
      url: "https://x/a", title: "t", text: "body",
      headings: ["Thời sự", "Thể thao"],
      scroll: { y: 700, height: 3000 },
      omitted_actions: 120,
      actions
    };
    const body = buildQuestions(page, "g", [], buildActionSpace(actions));
    assert.deepEqual(body.state.page.headings, ["Thời sự", "Thể thao"]);
    assert.deepEqual(body.state.page.scroll, { y: 700, height: 3000 });
    assert.equal(body.state.page.omitted, 120);
    const live = await open("/sections");
    const state = await observe(live);
    assert.ok(Array.isArray(state.headings), "snapshot returns headings");
    assert.ok(state.scroll && typeof state.scroll.height === "number");
  });

  await test("28. auto-continue resumes until expect passes (premature DONE)", async () => {
    const { runAutoContinue } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/twophase");
    let clicks = 0, claimed = false;
    const decide = ({ questions }) => {
      const criteria = questions.click_target?.criteria || {};
      const pick = (re) => Object.keys(criteria).find((k) => re.test(criteria[k].element || ""));
      const done = { answers: { operation: op(questions, "DONE") }, model: "fake" };
      let key = null;
      if (clicks === 0) key = pick(/go phase two/i);
      else if (!claimed) { claimed = true; return Promise.resolve(done); } // premature claim ends chunk 1
      else key = pick(/finish it/i);
      if (!key) return Promise.resolve(done);
      clicks++;
      return Promise.resolve({ answers: { operation: op(questions, "CLICK"), click_target: target(criteria, key) }, model: "fake" });
    };
    const { result, verification } = await runAutoContinue(s, {
      goal: "finish both phases", decide,
      expect: { text: ["PHASE DONE"] }, maxSteps: 4, maxMs: 15000
    });
    assert.ok(result.steps.some((st) => /go phase two/i.test(st.label || "")), "phase 1 ran");
    assert.ok(result.steps.some((st) => /finish it/i.test(st.label || "")), "phase 2 ran after auto-continue");
    assert.equal(verification.passed, true);
  });

  await test("29. scrolling that changes nothing is blocked as no-progress", async () => {
    const s = await open("/tallstatic");
    const decide = ({ questions }) => Promise.resolve(
      { answers: { operation: op(questions, "SCROLL_DOWN") }, model: "fake" });
    const result = await runTask(s, { goal: "reach the bottom", decide, maxSteps: 10, maxMs: 20000 });
    assert.equal(result.outcome, "no_progress",
      "scrolling a static page must not count as page progress");
    assert.ok(result.metrics.steps <= 4, "blocked right after the third no-change scroll");
  });

  await test("30. page text filters chrome/noise, keeps real content", async () => {
    const s = await open("/noisy");
    const state = await observe(s);
    const text = state.text || "";
    assert.ok(text.includes("Nội dung chính của bài viết"), "article content kept");
    assert.ok(state.headings.includes("Bài viết"), "heading kept");
    for (const noise of ["Accept all cookies", "Mua ngay", "Quyên góp", "Điều khoản", "Trang chủ"]) {
      assert.ok(!text.includes(noise), `filtered out: ${noise}`);
    }
    // Elements are untouched — only the body text is filtered.
    assert.ok(state.actions.some((a) => /quyên góp/i.test(a.label)), "buttons still actionable");
  });

  await test("31. SPA route change waits for the new view to mount", async () => {
    const s = await open("/spa");
    const link = (await observe(s)).actions.find((a) => /go spa/i.test(a.label));
    await s.act(link);
    const state = await s.current();
    assert.ok(state.actions.some((a) => /loaded two/i.test(a.label)),
      "route changed and the late-mounting view is in the table without a manual sleep");
    assert.equal(state.url.endsWith("/spa2"), true);
  });

  await closeProfile(profile).catch(() => {});
  await deleteProfile(profile).catch(() => {});
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
