// TDD hard-case suite — 10 tricky pages, real Chrome headless, fake Jev (offline).
// No login, no network: every page is a local fixture served in-process.
// Run: node host/test/browserUseCases.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const onlyCases = process.env.CASES?.split(","); // CASES=7,49 — run a subset by number
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

if (!hasChrome) {
  console.log("  - skipped (no Chrome binary found)");
} else {
  const engine = await import("../features/browserUse/engine.js");
  const { withSession, observe, runTask, typeById, closeProfile, profiles } = engine;

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
    "/dialog": `<!doctype html><html><body>
      <button onclick="alert('BOOM'); document.title='AFTER-ALERT'">Trigger alert</button>
      <button onclick="if(confirm('Sure?')) document.title='CONFIRMED'; else document.title='DENIED'">Trigger confirm</button>
      <button onclick="document.title='PLAIN'">Plain button</button>
    </body></html>`,
    "/upload": `<!doctype html><html><body>
      <label for="f">Ảnh đại diện</label>
      <input type="file" id="f">
      <div id="out">no file</div>
      <script>window.f.onchange = () => { document.getElementById('out').textContent = 'FILE:' + (f.files[0]?.name || 'none'); };<\/script>
    </body></html>`,
    "/download": `<!doctype html><html><body>
      <a href="/file.txt" download>Download file</a>
    </body></html>`,
    "/file.txt": "hello-download-content",
    "/drag": `<!doctype html><html><body>
      <div id="src" draggable="true" style="cursor:pointer;padding:10px;background:#eee">Drag me</div>
      <div id="dst" style="cursor:pointer;padding:20px;background:#dfd">Drop zone</div>
      <script>
        window.src.ondragstart = (e) => e.dataTransfer.setData('text/plain', 'PAYLOAD');
        window.dst.ondragover = (e) => e.preventDefault();
        window.dst.ondrop = (e) => { e.preventDefault(); document.title = 'DROPPED:' + e.dataTransfer.getData('text/plain'); };
      <\/script>
    </body></html>`,
    "/keys": `<!doctype html><html><body>
      <script>document.addEventListener('keydown', (e) => {
        document.title = 'KEY:' + e.key + ':' + (e.ctrlKey || e.metaKey) + ':' + e.shiftKey;
      });<\/script>
    </body></html>`,
    "/navslow": `<!doctype html><html><body>
      <a href="/veryslow">Go slow target</a>
    </body></html>`,
    "/veryslow": `<!doctype html><html><body>
      <h1>SLOW PAGE ARRIVED</h1>
      <button onclick="document.title='SLOW'">Late arrival button</button>
    </body></html>`,
    "/searchform": `<!doctype html><html><body>
      <form action="/veryslow" id="f"><input name="q" placeholder="Search term"
        onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('f').submit();}"></form>
    </body></html>`,
    "/tallpage": `<!doctype html><html><body>
      <button onclick="document.title='TOP'">Top button</button>
      <div style="height:3000px">filler</div>
      <button onclick="document.title='DEEP'" style="margin-bottom:40px">Deep footer button</button>
    </body></html>`,
    "/twophase": `<!doctype html><html><body>
      <button onclick="document.getElementById('f').style.display='block'">Go phase two</button>
      <button id="f" style="display:none" onclick="document.getElementById('out').textContent='PHASE DONE'">Finish it</button>
      <div id="out"></div>
    </body></html>`,
    "/duo": `<!doctype html><html><body>
      <button onclick="document.getElementById('log').textContent+='A'">First step</button>
      <button onclick="document.getElementById('log').textContent+='B'">Second step</button>
      <div id="log"></div>
    </body></html>`,
    "/plannav": `<!doctype html><html><body>
      <a href="/duo">Move away</a>
    </body></html>`,
    "/xy": `<!doctype html><html><body>
      <button style="position:fixed;left:520px;top:340px;width:80px;height:40px" onclick="document.title='XY'">Bullseye</button>
    </body></html>`,
    "/widget": `<!doctype html><html><head><style>.chk{cursor:pointer;padding:6px;display:block;width:200px}</style></head><body>
      <div class="chk" data-on="0">Hồ bơi 401</div>
      <label class="chk"><input type="checkbox" style="position:absolute;opacity:0;pointer-events:none"
        onchange="document.getElementById('out2').textContent=this.checked?'WIFI ON':''"><span>Wi-Fi miễn phí 500</span></label>
      <div id="out"></div>
      <div id="out2"></div>
      <script>
        document.querySelector('.chk').addEventListener('click', function () {
          this.dataset.on = this.dataset.on === '1' ? '0' : '1';
          document.getElementById('out').textContent = this.dataset.on === '1' ? 'POOL ON' : '';
        });
      <\/script>
    </body></html>`,
    "/misc": `<!doctype html><html><body style="margin:0">
      <div style="height:4000px;padding-top:10px">
        <div id="hov" onmouseenter="document.title='HOVERED'" style="padding:10px;background:#eee;cursor:pointer">Hover me</div>
        <input id="inp" placeholder="Type then Escape" onkeydown="if(event.key==='Escape')document.title='ESC'">
        <a href="/duo">To duo</a>
      </div>
      <div id="foot" style="height:400px">Very bottom</div>
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
  const dynamicPages = {}; // test-injected pages whose URLs are known only at runtime
  const server = http.createServer((req, res) => {
    const route = req.url.split("?")[0];
    if (route === "/veryslow") { // deliberately slow commit — navigate-aware settle must wait it out
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGES[route]);
      }, 3000);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dynamicPages[route] ?? PAGES[route] ?? PAGES["/"]);
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

  await test("7. 400 buttons: full-page table honors the cap, overflow omitted, scroll still offered", async () => {
    const { MAX_ELEMENTS } = await import("../features/browserUse/constants.js");
    const s = await open("/long");
    const state = await observe(s);
    const clicks = state.actions.filter((a) => a.kind === "click").length;
    assert.ok(clicks <= MAX_ELEMENTS, "cap holds");
    assert.equal(clicks, MAX_ELEMENTS, "table fills to the cap in page order");
    assert.equal(state.omitted_actions, 400 - MAX_ELEMENTS, "overflow reported");
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

  await test("14b. chain resolves targets by label and select value when id not specified", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/");
    const res = await invoke("chain", { profile, steps: [
      { op: "click", id: "Do it now" },
      { op: "select", id: "Beta" },
      { op: "type", id: "chain works", text: "label matching works" }
    ] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal(res.results.length, 3);
    assert.equal(res.state.title, "CE");
    assert.ok(res.state.text.includes("label matching works"));
  });

  await test("14c. chain failure includes suggestions of available elements", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/");
    const res = await invoke("chain", { profile, steps: [
      { op: "click", id: "NonExistentButton" }
    ] });
    assert.ok(!res.ok);
    assert.equal(res.failedStep, 1);
    assert.match(res.results[0].error, /Element "NonExistentButton" not observed/);
    assert.match(res.results[0].error, /Available: /);
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
      /matched 0 elements.*--fields/
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

  await test("32. micro-plan: two same-view clicks ride ONE model call", async () => {
    const s = await open("/duo");
    let calls = 0;
    const decide = ({ questions }) => {
      calls++;
      if (calls > 1) return Promise.resolve({ answers: { operation: op(questions, "DONE") }, model: "fake" });
      const criteria = questions.click_target?.criteria || {};
      const first = Object.keys(criteria).find((k) => /first step/i.test(criteria[k].element || ""));
      const stepCriteria = questions.step_2?.criteria || {};
      const second = Object.keys(stepCriteria).find((k) => /second step/i.test(stepCriteria[k] || ""));
      return Promise.resolve({
        answers: {
          operation: op(questions, "CLICK"),
          click_target: target(criteria, first),
          step_2: target(stepCriteria, second || "SKIP")
        },
        model: "fake"
      });
    };
    const result = await runTask(s, { goal: "Click First step then Second step", decide, maxSteps: 4, maxMs: 15000 });
    assert.equal(result.outcome, "needs_verification");
    const log = ((await observe(s)).text || "").replace(/\s+/g, "");
    assert.ok(log.includes("AB"), `both plan actions ran: ${log}`);
    assert.equal(calls, 2, "one call carried both actions, one confirmed DONE");
    assert.equal(result.metrics.modelCalls, 2);
  });

  await test("33. a plan is dropped when its action navigates away", async () => {
    const s = await open("/plannav");
    let calls = 0;
    const decide = ({ questions }) => {
      calls++;
      if (calls > 1) return Promise.resolve({ answers: { operation: op(questions, "DONE") }, model: "fake" });
      const criteria = questions.click_target?.criteria || {};
      const link = Object.keys(criteria).find((k) => /move away/i.test(criteria[k].element || ""));
      // step_2 aims at a /duo button planned from the OLD page — must never run.
      const stepCriteria = questions.step_2?.criteria || {};
      const stale = Object.keys(stepCriteria).find((k) => /first step/i.test(stepCriteria[k] || ""));
      return Promise.resolve({
        answers: {
          operation: op(questions, "CLICK"),
          click_target: target(criteria, link),
          step_2: target(stepCriteria, stale || "SKIP")
        },
        model: "fake"
      });
    };
    const result = await runTask(s, { goal: "Click Move away", decide, maxSteps: 4, maxMs: 15000 });
    assert.equal(result.outcome, "needs_verification");
    const text = ((await observe(s)).text || "").replace(/\s+/g, "");
    assert.ok(!text.includes("AB"), "stale plan step did not execute after navigation");
  });

  await test("34. tab discipline: one tab per site, new origin opens a tracked tab", async () => {
    const tabProfile = `tabs-${Date.now()}`;
    const server2 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGES[req.url] ?? PAGES["/"]);
    });
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const countTabs = async (s) =>
      (await s.client.call("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
    try {
      let s = await withSession({ profile: tabProfile, url: `${base}/duo`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 1, "first open uses the launch tab");
      s = await withSession({ profile: tabProfile, url: `${base}/`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 1, "same-origin open reuses the site tab");
      s = await withSession({ profile: tabProfile, url: `${base}/duo`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 1, "exact/same-origin return stays on one tab");
      s = await withSession({ profile: tabProfile, url: `${base2}/`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 2, "a new origin opens a second (tracked) tab");
      s = await withSession({ profile: tabProfile, url: `${base}/duo`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 2, "returning to site one refocuses its tab, no third tab");
      assert.ok((await observe(s)).actions.length, "session observes the refocused tab");
    } finally {
      await closeProfile(tabProfile).catch(() => {});
      await profiles.remove(tabProfile).catch(() => {});
      server2.close();
    }
  });

  await test("35b. step frame: written per action, cleaned with the profile", async () => {
    const frameProfile = `frame-${Date.now()}`;
    const frame = path.join(os.homedir(), ".9remote", "browserUse", "frames", `${frameProfile}.jpg`);
    const s = await withSession({ profile: frameProfile, url: `${base}/duo`, headless: true }, (x) => x);
    const btn = (await observe(s)).actions.find((a) => /first step/i.test(a.label));
    await s.act(btn);
    await s.stepFrame();
    assert.ok(fs.existsSync(frame) && fs.statSync(frame).size > 500, "scaled frame written");
    assert.ok(engine.readStepFrame({ profile: frameProfile }), "frame reads back as base64");
    assert.equal(engine.readStepFrame({ profile: "no-such-profile" }), null, "absent frame -> null");
    await profiles.remove(frameProfile).catch(() => {});
    assert.ok(!fs.existsSync(frame), "frame removed with the profile");
  });

  await test("34b. clickxy dispatches a coordinate click on invisible-to-snapshot widgets", async () => {
    const s = await open("/xy");
    // The button is a plain button (snapshot sees it) — the point is that the
    // COORDINATE path alone lands the click, as it must for div-role widgets.
    await s.clickPoint(560, 360);
    assert.equal((await observe(s)).title, "XY");
    await assert.rejects(() => s.clickPoint("x", null), /numeric x and y/);
  });

  await test("34c. pointer-styled custom widgets enter the table with coordinates", async () => {
    const s = await open("/widget");
    const state = await observe(s);
    const chk = state.actions.find((a) => /hồ bơi/i.test(a.label || ""));
    assert.ok(chk, "delegated div checkbox observed without any ARIA role");
    assert.ok(chk.rect && chk.rect.w > 0 && Number.isFinite(chk.rect.x), "action carries a rect for coordinate clicks");
    await s.act(chk); // Jev's own path: element-id click, no coordinates needed
    assert.ok(((await observe(s)).text || "").includes("POOL ON"), "custom widget toggled via element id");
    const ghost = state.actions.find((a) => /wi-fi miễn phí/i.test(a.label || ""));
    assert.ok(ghost, "label wrapping a hidden checkbox observed as its click proxy");
    await s.act(ghost);
    assert.ok(((await observe(s)).text || "").includes("WIFI ON"), "hidden-checkbox label toggled via element id");
  });

  await test("34d. primitives: scroll edges/by, history, key, hover, waitText", async () => {
    const s = await open("/misc");
    // hover + named keys on the fresh load (bfcache-restored pages can miss
    // pointer-styled widgets on the first observe — known quirk, parked)
    const hov = (await observe(s)).actions.find((a) => /hover me/i.test(a.label));
    assert.ok(hov, "pointer-styled hover target observed");
    await s.hoverById(hov.id);
    assert.equal((await observe(s)).title, "HOVERED", "hover delivered a mouseMoved event");
    const inp = (await observe(s)).actions.find((a) => a.kind === "fill");
    await s.act(inp, "hi");
    await s.sendKey("escape");
    assert.equal((await observe(s)).title, "ESC", "escape key delivered");
    await assert.rejects(() => s.sendKey("nope"), /Unsupported key/);
    // scroll edges and by-pixel
    await s.scrollToEdge("bottom");
    let st = await observe(s);
    assert.ok(st.scroll.y + st.w >= st.scroll.height - 2, "scroll bottom reaches the end");
    await s.scrollToEdge("top");
    st = await observe(s);
    assert.equal(st.scroll.y, 0, "scroll top returns to zero");
    await s.scrollBy(300);
    st = await observe(s);
    assert.ok(Math.abs(st.scroll.y - 300) < 60, `scrollBy landed near 300 (got ${st.scroll.y})`);
    await s.scrollBy(-150);
    st = await observe(s);
    assert.ok(Math.abs(st.scroll.y - 150) < 60, `negative scrollBy goes back up (got ${st.scroll.y})`);
    // history: follow the link, then back returns, forward re-enters
    await s.scrollToEdge("top"); // scrolling moved the controls out of view — come back
    const link = (await observe(s)).actions.find((a) => /to duo/i.test(a.label));
    await s.act(link);
    assert.ok((await observe(s)).url.endsWith("/duo"), "navigated to /duo");
    await s.historyGo(-1);
    assert.ok((await observe(s)).url.endsWith("/misc"), "history back returns to /misc");
    await s.historyGo(1);
    assert.ok((await observe(s)).url.endsWith("/duo"), "history forward re-enters /duo");
    // waitText catches late content on /slow
    const slow = await open("/slow");
    const waited = await slow.waitText("Reveal target", 4000);
    assert.equal(waited.found, true, "waitText found the late-rendered button");
    const missed = await slow.waitText("không tồn tại đâu đó", 300);
    assert.equal(missed.found, false, "waitText times out bounded");
  });

  await test("35. plan questions flatten to SKIP + element choices", async () => {
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const actions = [
      { id: "e1", kind: "click", label: "Go", role: "button", value: "", node: 1 },
      { id: "e2", kind: "fill", label: "Name", value: "", node: 2 },
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
      { id: "wait", kind: "wait", label: "Wait" }
    ];
    const space = buildActionSpace(actions, { Name: "Alice" });
    const body = buildQuestions({ url: "https://x", title: "t", text: "", actions }, "g", [], space);
    const criteria = body.questions.step_2.criteria;
    assert.ok(criteria.SKIP, "SKIP ends the batch");
    assert.match(String(criteria.e1), /Click Go/);
    assert.match(String(criteria.e2), /Type into Name/);
    assert.ok(criteria.SCROLL_DOWN, "scroll is plannable");
    assert.ok(!criteria.WAIT, "wait is not plannable");
    assert.ok(body.questions.step_3, "plan questions run to PLAN_MAX");
  });

  await test("36. js dialogs auto-dismiss — alert/confirm never wedge the CDP loop", async () => {
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out — dialog wedged CDP`)), ms))
    ]);
    const s = await open("/dialog");
    const buttons = (await observe(s)).actions.filter((a) => a.kind === "click");
    const alertBtn = buttons.find((a) => /trigger alert/i.test(a.label));
    const confirmBtn = buttons.find((a) => /trigger confirm/i.test(a.label));
    await withTimeout(s.act(alertBtn), 8000, "alert click");
    const st1 = await withTimeout(observe(s), 8000, "observe after alert");
    assert.equal(st1.title, "AFTER-ALERT", "alert dismissed and JS resumed");
    await withTimeout(s.act(confirmBtn), 8000, "confirm click");
    const st2 = await withTimeout(observe(s), 8000, "observe after confirm");
    assert.equal(st2.title, "CONFIRMED", "confirm accepted (default)");
  });

  await test("37. file upload: observed in the table, set via CDP, never offered to Jev", async () => {
    const { buildActionSpace } = await import("../features/browserUse/agentLoop.js");
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/upload");
    const state = await observe(s);
    const fileInput = state.actions.find((a) => a.kind === "upload");
    assert.ok(fileInput, "file input missing from the element table");
    assert.match(fileInput.label, /ảnh đại diện/i);

    // The choice loop must NEVER get it — clicking opens a native picker CDP cannot drive
    const space = buildActionSpace(state.actions);
    const offered = [...Object.values(space.targets)].flatMap((m) => Object.keys(m));
    assert.ok(!offered.includes(fileInput.id), "upload action leaked into Jev's choice space");

    const tmp = `/tmp/9r-upload-${Date.now()}.txt`;
    fs.writeFileSync(tmp, "upload test");
    const res = await invoke("upload", { profile, id: fileInput.id, file: tmp });
    assert.ok(res.ok, JSON.stringify(res));
    const after = await observe(s);
    assert.match(after.text, /FILE:9r-upload-/, "change event fired with the file name");
    fs.unlinkSync(tmp);
  });

  await test("38. downloads land in a known dir; waitDownload returns the path", async () => {
    const s = await open("/download");
    const link = (await observe(s)).actions.find((a) => /download file/i.test(a.label));
    assert.ok(link, "download link observed");
    await s.act(link);
    const dl = await s.waitDownload(8000);
    assert.ok(dl, "download never completed within the bound");
    assert.match(dl.filename, /file/);
    assert.ok(fs.existsSync(dl.path), "downloaded file exists on disk");
    assert.equal(fs.readFileSync(dl.path, "utf8"), "hello-download-content", "content matches");
  });

  await test("39. drag & drop between two observed elements", async () => {
    const s = await open("/drag");
    const state = await observe(s);
    const src = state.actions.find((a) => /drag me/i.test(a.label));
    const dst = state.actions.find((a) => /drop zone/i.test(a.label));
    assert.ok(src && dst, "both drag endpoints observed");
    await s.dragTo(src, dst);
    assert.equal((await observe(s)).title, "DROPPED:PAYLOAD", "HTML5 drop fired with dataTransfer");
  });

  await test("40. sendKey handles modifier combos (ctrl+a, meta+c)", async () => {
    const s = await open("/keys");
    await s.sendKey("ctrl+a");
    assert.equal((await observe(s)).title, "KEY:a:true:false", "ctrl+a delivered with ctrlKey");
    await s.sendKey("escape");
    assert.equal((await observe(s)).title, "KEY:Escape:false:false", "plain key still works");
  });

  await test("41. click to a slow page returns the NEW page table, not the old one", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/navslow");
    const link = (await observe(await open("/navslow"))).actions.find((a) => /go slow target/i.test(a.label));
    const data = await invoke("click", { profile, id: link.id });
    assert.ok(data.state.url.includes("/veryslow"), `still on ${data.state.url}`);
    assert.match(data.state.text, /SLOW PAGE ARRIVED/, "new page content observed");
  });

  await test("42. type --enter submitting to a slow page returns the new table", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/searchform");
    const field = (await observe(s)).actions.find((a) => a.kind === "fill");
    const data = await invoke("type", { profile, id: field.id, text: "hello", enter: true });
    assert.ok(data.state.url.includes("/veryslow"), `still on ${data.state.url}`);
    assert.match(data.state.text, /SLOW PAGE ARRIVED/);
  });

  await test("43. in-place clicks do NOT pay the navigation wait", async () => {
    const s = await open("/twophase");
    const phaseOne = (await observe(s)).actions.find((a) => /go phase two/i.test(a.label));
    const started = Date.now();
    await s.act(phaseOne);
    const elapsed = Date.now() - started;
    const st = await observe(s);
    assert.ok(st.actions.some((a) => /finish it/i.test(a.label)), "in-place click still lands");
    assert.ok(elapsed < 2500, `in-place click took ${elapsed}ms — navigation wait leaked`);
  });

  await test("44. click --wait 'text' gates completion in the same call", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/twophase");
    const finish = (await observe(s)).actions.find((a) => /finish it/i.test(a.label));
    const data = await invoke("click", { profile, id: finish.id, wait: "PHASE DONE" });
    assert.equal(data.found, true, "wait text observed in the same response");
    assert.match(data.state.text, /PHASE DONE/);
  });

  await test("45. full-page snapshot: below-fold elements appear without scrolling", async () => {
    const s = await open("/tallpage");
    const state = await observe(s);
    assert.ok(state.actions.some((a) => /top button/i.test(a.label)), "top element present");
    assert.ok(state.actions.some((a) => /deep footer button/i.test(a.label)),
      "below-fold element must be in the table without any scroll");
    assert.match(state.text, /filler/, "below-fold text readable");
  });

  await test("46. clicking a below-fold element scrolls it into view and lands", async () => {
    const s = await open("/tallpage");
    const state = await observe(s);
    const deep = state.actions.find((a) => /deep footer button/i.test(a.label));
    await s.act(deep);
    assert.equal((await observe(s)).title, "DEEP", "clicked the off-viewport element");
  });

  await test("47. scrolling alone is not page progress (contentMarker ignores offsets)", async () => {
    const s = await open("/tallpage");
    const before = await observe(s);
    await s.scrollBy(800);
    const after = await observe(s);
    assert.deepEqual(after.contentMarker, before.contentMarker,
      "pure scrolling must not look like new content");
  });

  await test("48. open/reuse never steals focus (no Page.bringToFront in the flow)", async () => {
    // Spy on outgoing CDP commands for the whole profile session
    const session = (await import("../features/browserUse/engine.js")).sessionStatus?.();
    await open("/tallpage"); // may create the tab (fresh origin for this test)
    const spy = await withSession({ profile }, async (s) => {
      const orig = s.client.call.bind(s.client);
      let front = 0;
      s.client.call = (method, params, sid) => {
        if (method === "Page.bringToFront") front++;
        return orig(method, params, sid);
      };
      // open() is withSession too — calling it nested on the same profile
      // self-deadlocks the per-profile mutex; drive the same branches directly.
      await s.openOrReuseTab(base + "/tallpage");        // exact-match reuse branch
      await s.openOrReuseTab(base + "/tallpage#anchor"); // same-origin branch
      const st = await observe(s);
      const top = st.actions.find((a) => /top button/i.test(a.label));
      await s.act(top);                   // interaction still lands without real focus
      await new Promise((r) => setTimeout(r, 50));
      return front;
    });
    assert.equal(spy, 0, "Page.bringToFront fired during open/reuse — focus stolen");
    const after = await observe(await open("/tallpage"));
    assert.equal(after.title, "TOP", "click landed without bringing the tab to front");
  });

  await test("49. cross-origin iframe (OOPIF): observed, clickable — orca pattern", async () => {
    const childPages = {
      "/xf-child": `<!doctype html><html><body><button onclick="location.href='/xf-child2'">Iframe inner button</button></body></html>`,
      "/xf-child2": `<!doctype html><html><body><button>In frame two</button></body></html>`
    };
    const childSrv = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(childPages[q.url.split("?")[0]] ?? childPages["/xf-child"]);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    const childUrl = `http://localhost:${childSrv.address().port}/xf-child`;
    dynamicPages["/xframe"] = `<!doctype html><html><body>
      <button onclick="document.title='OUT'">Outside frame</button>
      <iframe src="${childUrl}" style="width:300px;height:120px"></iframe>
    </body></html>`;
    try {
      const s = await open("/xframe");
      const st1 = await observe(s);
      const inner = st1.actions.find((a) => /iframe inner button/i.test(a.label));
      assert.ok(inner, "iframe button must appear in the table");
      assert.ok(inner.frame, "iframe action carries its frame session id");
      await s.act(inner);
      const st2 = await observe(s);
      assert.ok(st2.actions.some((a) => /in frame two/i.test(a.label)),
        "click navigated the cross-origin frame");
      assert.ok(st2.actions.some((a) => /outside frame/i.test(a.label)), "parent actions intact");
    } finally {
      delete dynamicPages["/xframe"];
      childSrv.close();
    }
  });

  await test("50. every question stays under the provider choice cap (255)", async () => {
    const { buildActionSpace, buildQuestions } = await import("../features/browserUse/agentLoop.js");
    const { MAX_CHOICES } = await import("../features/browserUse/constants.js");
    const many = [];
    for (let i = 1; i <= 600; i++) {
      many.push({ id: "e" + i, node: i, kind: "click", role: "link", label: "Link " + i, value: "", ctx: null });
    }
    const space = buildActionSpace(many);
    const body = buildQuestions({ url: "https://x", title: "t", text: "", actions: many }, "g", [], space);
    const sizes = Object.values(body.questions).map((q) => Object.keys(q.criteria).length);
    assert.ok(Math.max(...sizes) <= MAX_CHOICES,
      `question exceeded the provider cap: ${Math.max(...sizes)} > ${MAX_CHOICES}`);
  });

  await test("51. fresh() is frame-aware: idle iframe pages cache-hit, frame changes do not", async () => {
    const childSrv = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(`<!doctype html><html><body><button id="b">Static inner</button></body></html>`);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    dynamicPages["/xframe-idle"] = `<!doctype html><html><body>
      <button onclick="document.title='O'">Outer</button>
      <iframe src="http://localhost:${childSrv.address().port}/" style="width:300px;height:100px"></iframe>
    </body></html>`;
    try {
      const s = await open("/xframe-idle");
      const a = await observe(s);
      assert.ok(a.frames?.length, "iframe markers recorded on the state");
      assert.strictEqual(await s.current(), a, "idle page must serve the cached state (no re-observe)");
      const { evaluate } = await import("../features/browserUse/snapshot.js");
      await evaluate(s.client, a.frames[0].sessionId,
        `document.getElementById('b').textContent = 'Changed inside'`);
      assert.equal(await s.fresh(a), false, "a frame-only change must invalidate freshness");
    } finally {
      delete dynamicPages["/xframe-idle"];
      childSrv.close();
    }
  });

  await closeProfile(profile).catch(() => {});
  await profiles.remove(profile).catch(() => {});
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
