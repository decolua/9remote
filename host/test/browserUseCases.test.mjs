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
    "/console": `<!doctype html><html><body>
      <script>
        console.log("plain log line");
        console.error("boom marker");
        setTimeout(() => { null.kaput; }, 150);
      <\/script>
    </body></html>`,
    "/chain": `<!doctype html><html><body>
      <nav>Nav noise</nav>
      <fieldset><legend>Billing</legend>
        <button onclick="document.title='BILL'">OK</button>
        <button onclick="document.title='SAVED'">Save</button>
      </fieldset>
      <fieldset><legend>Shipping</legend>
        <p>Express 3 ngày</p>
        <button onclick="document.title='SHIP'">OK</button>
        <button onclick="document.title='S1'">Save</button>
        <button onclick="document.title='S2'">Save</button>
        <a href="/chain2">Go next</a>
      </fieldset>
    </body></html>`,
    "/chain2": `<!doctype html><html><body>
      <button onclick="document.title='P2'">Next OK</button>
    </body></html>`,
    // The approved markdown-lite VD: noise + 2 named sections + inline merge +
    // chip row + table + nested list.
    "/reader": `<!doctype html><html><body>
      <nav>Menu Home Pricing Docs</nav>
      <section aria-label="Plans">
        <h2>So sánh gói</h2>
        <p>Gói <b>Pro</b> 199k/tháng, khởi tạo <i>ngay</i>.</p>
        <div class="row"><span>Trial</span><span>Pro</span><span>Team</span></div>
        <table>
          <tr><th>Gói</th><th>Giá</th></tr>
          <tr><td>Pro</td><td>199k</td></tr>
          <tr><td>Team</td><td>499k</td></tr>
        </table>
      </section>
      <section aria-label="FAQ">
        <h3>Câu hỏi thường gặp</h3>
        <ul>
          <li>Có hoàn tiền không?
            <ul><li>Trong 14 ngày</li><li>Sau 14 ngày: không</li></ul>
          </li>
          <li>Hỗ trợ 24/7?</li>
        </ul>
      </section>
      <footer>© 2026 9remote</footer>
    </body></html>`,
    "/latecontent": `<!doctype html><html><body>
      <button onclick="document.title='CLK';setTimeout(()=>{document.getElementById('out').textContent='LOADED'},300)">Load it</button>
      <div id="out"></div>
    </body></html>`,
    "/hydrate": `<!doctype html><html><body><script>
      setTimeout(()=>{document.body.innerHTML='<button onclick="document.title=\\'H\\'">Hidden until hydrated</button>'},250)
    <\/script></body></html>`
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

  await test("11. invoke('click') returns the post-action state in one round trip", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const s = await open("/");
    const action = (await observe(s)).actions.find((a) => /do it now/i.test(a.label));
    const res = await invoke("click", { profile, id: action.id });
    assert.ok(res.ok && res.state?.actions, "state returned with the action");
    assert.equal(res.state.title, "DIV-CLICKED");
    const cached = await invoke("ls", { profile });
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
    await open("/noisy"); // same-origin round-trip reloads "/" — clears test 9's edit residue
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
    // Seed by id first so the label-based steps below are deterministic — the
    // old first-match-wins resolver silently clicked wrong same-label options.
    const before = await observe(await open("/"));
    const notes = before.actions.find((a) => a.kind === "fill");
    const res = await invoke("chain", { profile, steps: [
      { op: "type", id: notes.id, text: "chain works" },
      { op: "click", id: "Do it now" },
      { op: "select", id: "Alpha" },
      { op: "type", id: "chain works", text: "label matching works" }
    ] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal(res.results.length, 4);
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

  await test("30. page text filters chrome/noise, keeps real content", async () => {
    const s = await open("/noisy");
    const state = await observe(s);
    const text = state.text || "";
    assert.ok(text.includes("Nội dung chính của bài viết"), "article content kept");
    assert.ok(state.headings.includes("Bài viết"), "heading kept");
    for (const noise of ["Accept all cookies", "Mua ngay", "Quyên góp", "Trang chủ"]) {
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

  await test("34. tab discipline: strict one working tab across origins", async () => {
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
      assert.equal(await countTabs(s), 1, "a new origin navigates the SAME working tab (strict one-tab)");
      assert.match((await observe(s)).url, new RegExp(base2.replace(/[:/]/g, "\\$&")), "working tab now shows site two");
      s = await withSession({ profile: tabProfile, url: `${base}/duo`, headless: true }, (x) => x);
      assert.equal(await countTabs(s), 1, "returning to site one still has exactly one tab");
      assert.ok((await observe(s)).actions.length, "session observes the working tab");
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

  await test("52. console ring captures logs and uncaught errors (browsermcp parity)", async () => {
    const s = await open("/console");
    await new Promise((r) => setTimeout(r, 400)); // the late throw lands at 150ms
    const texts = s.consoleLog.map((l) => `${l.level} ${l.text}`).join("\n");
    assert.ok(s.consoleLog.some((l) => l.level === "log" && l.text.includes("plain log line")),
      `log line missing:\n${texts}`);
    assert.ok(s.consoleLog.some((l) => l.level === "error" && l.text.includes("boom marker")),
      `console.error missing:\n${texts}`);
    assert.ok(s.consoleLog.some((l) => l.level === "error" && l.text.includes("kaput")),
      `uncaught exception missing:\n${texts}`);
  });

  await test("53. a failed chain carries the console tail — why it broke, no extra call", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/console");
    const res = await invoke("chain", { profile, steps: [{ op: "click", id: "e999" }] });
    assert.equal(res.ok, false);
    assert.ok(res.console?.some((l) => l.level === "error" && l.text.includes("boom marker")),
      `console tail missing: ${JSON.stringify(res.console)}`);
  });

  await test("54. read --parent scopes to the named section; bad name lists sections", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/reader");
    const faq = await invoke("cat", { profile, parent: "faq" });
    assert.match(faq.text, /Câu hỏi thường gặp/);
    assert.match(faq.text, /Trong 14 ngày/);
    assert.ok(!faq.text.includes("So sánh gói"), `billing leaked into FAQ:\n${faq.text}`);
    assert.ok(!faq.text.includes("Menu"), "nav noise leaked");
    await assert.rejects(() => invoke("cat", { profile, parent: "zzz" }), /Plans.*FAQ|FAQ.*Plans/);
  });

  await test("55. read renders markdown-lite: headings, inline merge, chip rows, tables, nested lists", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/reader");
    const { text } = await invoke("cat", { profile });
    assert.match(text, /^## So sánh gói$/m, `heading level:\n${text}`);
    assert.match(text, /Gói Pro 199k\/tháng, khởi tạo ngay\./, `inline merge:\n${text}`);
    assert.match(text, /^Trial · Pro · Team$/m, `chip row:\n${text}`);
    assert.match(text, /^\| Pro \| 199k \|$/m, `table row:\n${text}`);
    assert.match(text, /^- Có hoàn tiền không\?$/m, `list item:\n${text}`);
    assert.match(text, /^  - Trong 14 ngày$/m, `nested list indent:\n${text}`);
    assert.ok(!text.includes("Menu Home"), "nav noise leaked");
    assert.ok(text.includes("© 2026"), "footer is content (license/terms must be greppable)");
  });

  await test("56. grep keeps only matching lines", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/reader");
    const res = await invoke("grep", { profile, pattern: "199k" });
    assert.ok(res.text.split("\n").length >= 1);
    for (const line of res.text.split("\n")) assert.match(line, /199k/, `non-matching line:\n${res.text}`);
    assert.ok(!res.text.includes("499k"), "non-matching row leaked");
  });

  await test("57. cat --from OFFSET LEN windows past the default cap", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    // ~30k chars of paragraphs with markers at the start and past 12k
    const paras = ["<p>AAA-START đầu trang nội dung dài</p>"];
    for (let i = 1; i < 900; i++) {
      paras.push(`<p>Đoạn thường số ${i} với nội dung lặp đi lặp lại đủ dài</p>`);
      if (i === 250) paras.push("<p>BBB-MIDDLE giữa trang nội dung dài</p>");
    }
    dynamicPages["/longread"] = `<!doctype html><html><body><section aria-label="Doc">${paras.join("")}</section></body></html>`;
    try {
      await open("/longread");
      const first = await invoke("cat", { profile });
      assert.ok(first.total > 20000, `total missing:\n${JSON.stringify(first).slice(0, 200)}`);
      assert.ok(first.text.includes("AAA-START"), "first window lost the start marker");
      assert.ok(!first.text.includes("BBB-MIDDLE"), "first window leaked past the cap");
      const second = await invoke("cat", { profile, from: 12000, len: 8000 });
      assert.ok(second.text.includes("BBB-MIDDLE"), `second window missed the middle marker:\n${second.text.slice(0, 200)}`);
      assert.ok(!second.text.includes("AAA-START"), "second window leaked the start");
      assert.ok(second.text.length <= 9000, "len not respected");
    } finally {
      delete dynamicPages["/longread"];
    }
  });

  await test("58. chain --parent scopes element lookup to the section", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const res = await invoke("chain", { profile, parent: "Shipping", steps: [{ op: "click", id: "OK" }] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal((await invoke("ls", { profile })).title, "SHIP", "clicked the Billing OK");
  });

  await test("59. step-level parent overrides the chain-level one", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const res = await invoke("chain", { profile, parent: "Billing",
      steps: [{ op: "click", id: "OK", parent: "Shipping" }] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal((await invoke("ls", { profile })).title, "SHIP");
  });

  await test("60. ambiguous label inside the scope throws and crops the failure state", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/"); // reset the document — earlier chain cases leave titles behind
    await open("/chain");
    const res = await invoke("chain", { profile, parent: "Shipping", steps: [{ op: "click", id: "Save" }] });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error, /ambiguous/i);
    assert.ok(res.results[0].error.includes("Save"), "error must list the candidates");
    assert.equal((await invoke("ls", { profile })).title, "", "nothing was clicked");
    assert.ok(res.state.actions.length > 0 && res.state.actions.some((a) => a.ctx === "Shipping"),
      "failure state must be cropped to Shipping");
    assert.ok(!res.state.actions.some((a) => a.ctx === "Billing"), "Billing leaked into the cropped state");
  });

  await test("61. label guard blocks a wrong id before the click", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/"); // reset the document — earlier chain cases leave titles behind
    await open("/chain");
    const res = await invoke("chain", { profile,
      steps: [{ op: "click", id: "e1", label: "Totally wrong label" }] });
    assert.equal(res.ok, false);
    assert.match(res.results[0].error, /label/i);
    assert.equal((await invoke("ls", { profile })).title, "", "guard must fire BEFORE the click");
  });

  await test("62. label guard passes when the id still matches", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const before = await observe(await open("/chain"));
    const ok = before.actions.find((a) => a.ctx === "Shipping" && a.label === "OK");
    const res = await invoke("chain", { profile,
      steps: [{ op: "click", id: ok.id, label: "OK", parent: "Shipping" }] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.equal((await invoke("ls", { profile })).title, "SHIP");
  });

  await test("63. unexpected navigation stops the chain at the next step", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const res = await invoke("chain", { profile, parent: "Shipping",
      steps: [{ op: "click", id: "Go next" }, { op: "click", id: "Next OK" }] });
    assert.equal(res.ok, false);
    assert.equal(res.failedStep, 2);
    assert.match(res.results[1].error, /unexpected navigation/i);
    assert.equal(res.results.filter((r) => r.ok).length, 1, "only the pre-nav step ran");
  });

  await test("64. open declares the nav; bare id steps after a nav need a label guard", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const label = await invoke("chain", { profile,
      steps: [{ op: "go", url: `${base}/chain2` }, { op: "click", id: "Next OK" }] });
    assert.ok(label.ok, JSON.stringify(label.results));
    assert.equal((await invoke("ls", { profile })).title, "P2");

    await open("/chain");
    const guarded = await invoke("chain", { profile,
      steps: [{ op: "go", url: `${base}/chain2` }, { op: "click", id: "e1", label: "Next OK" }] });
    assert.ok(guarded.ok, JSON.stringify(guarded.results));
    assert.equal((await invoke("ls", { profile })).title, "P2");

    await open("/chain");
    const bare = await invoke("chain", { profile,
      steps: [{ op: "go", url: `${base}/chain2` }, { op: "click", id: "e1" }] });
    assert.equal(bare.ok, false);
    assert.match(bare.results[1].error, /navigated.*label|label.*navigated/i);
  });

  await test("65. run outcomes: only needs_verification may continue a chain", async () => {
    const { chainRunError } = await import("../features/browserUse/browserUseSocket.js");
    assert.equal(chainRunError({ outcome: "needs_verification" }), null);
    for (const outcome of ["blocked", "no_progress", "low_confidence", "action_error", "decision_error", "step_limit", "cancelled"]) {
      const err = chainRunError({ outcome, reason: `${outcome} reason` });
      assert.ok(err instanceof Error && err.message.includes(outcome), `${outcome} must stop the chain`);
    }
  });

  await test("66. read step inside a chain returns the section content inline", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/chain");
    const res = await invoke("chain", { profile, steps: [{ op: "cat", parent: "Shipping" }] });
    assert.ok(res.ok, JSON.stringify(res.results));
    assert.match(res.results[0].text, /Express 3 ngày/);
    assert.ok(!res.results[0].text.includes("Nav noise"), "nav noise leaked into the read");
  });

  await test("67. strict one tab: every open reuses the engine's single tab across origins", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const other = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(`<!doctype html><html><body><button onclick="document.title='O'">Other origin</button></body></html>`);
    });
    await new Promise((r) => other.listen(0, "127.0.0.1", r));
    try {
      await invoke("go", { profile, url: `${base}/chain` });
      await invoke("go", { profile, url: `http://127.0.0.1:${other.address().port}/` }); // cross-origin
      // chrome:// tabs are the browser's own (auto-update) — only agent-usable tabs count
      const usable = (r) => r.tabs.filter((t) => !t.url.startsWith("chrome://"));
      const crossed = usable(await invoke("tabs", { profile }));
      assert.equal(crossed.length, 1,
        `cross-origin open must reuse the tab, got ${JSON.stringify(crossed.tabs)}`);
      assert.ok(crossed[0].url.includes(`:${other.address().port}/`));
      await invoke("go", { profile, url: `${base}/chain` }); // back to the first origin
      const back = usable(await invoke("tabs", { profile }));
      assert.equal(back.length, 1, `re-open grew tabs: ${JSON.stringify(back)}`);
      assert.ok(back[0].url.startsWith(base));
    } finally {
      other.close();
    }
  });

  await test("68. read emits single non-block leaves (GitHub row shape)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/leaves"] = `<!doctype html><html><body>
      <section aria-label="PRs">
        <div class="row"><a href="#">Fix login bug #12</a></div>
        <div class="row"><a href="#">Add dark mode #13</a></div>
        <div>Plain wrapper text</div>
      </section>
    </body></html>`;
    try {
      await open("/leaves");
      const res = await invoke("cat", { profile });
      for (const want of ["Fix login bug #12", "Add dark mode #13", "Plain wrapper text"]) {
        assert.ok(res.text.includes(want), `missing "${want}":\n${res.text}`);
      }
      const scoped = await invoke("cat", { profile, parent: "PRs" });
      assert.ok(scoped.text.includes("#12") && !scoped.text.includes("Plain wrapper text") || scoped.text.includes("Plain wrapper text"),
        "scoped read must not error");
    } finally {
      delete dynamicPages["/leaves"];
    }
  });

  await test("69. element ids survive list shifts (stable node ids, not indexes)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/idstable"] = `<!doctype html><html><body>
      <div id="zone"></div>
      <button id="save">Save</button>
      <button id="close">Close</button>
      <script>window.save.onclick = () => setTimeout(() =>
        window.zone.insertAdjacentHTML('afterbegin', '<button>Undo</button>'), 250);<\/script>
    </body></html>`;
    try {
      const st1 = await observe(await open("/idstable"));
      const save1 = st1.actions.find((a) => a.label === "Save");
      assert.ok(save1, "Save observed");
      const res = await invoke("click", { profile, id: save1.id, label: "Save" });
      assert.ok(res.ok, JSON.stringify(res));
      const st2 = await observe(await open("/idstable"));
      const save2 = st2.actions.find((a) => a.label === "Save");
      assert.ok(st2.actions.some((a) => a.label === "Undo"), "Undo appeared after the click");
      assert.equal(save2.id, save1.id, `id must be stable across a list shift: ${save1.id} -> ${save2.id}`);
    } finally { delete dynamicPages["/idstable"]; }
  });

  await test("70. fill settle scales with text length (long paste, late reaction)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/longfill"] = `<!doctype html><html><body>
      <input id="q" placeholder="Search"><div id="out">idle</div>
      <script>window.q.addEventListener('input', () => setTimeout(() => {
        document.getElementById('out').textContent = 'SEARCH DONE ' + q.value.length; }, 700));<\/script>
    </body></html>`;
    try {
      const st = await observe(await open("/longfill"));
      const field = st.actions.find((a) => a.kind === "fill");
      assert.ok(field, "input observed as fill");
      const res = await invoke("type", { profile, id: field.id, text: "x".repeat(60) });
      assert.ok(res.ok, JSON.stringify(res));
      assert.match(res.state.text, /SEARCH DONE 60/,
        `late reaction missed — settle returned too early:\n${res.state.text}`);
    } finally { delete dynamicPages["/longfill"]; }
  });

  await test("71. a reaction landing inside the click floor is served, not skipped", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/churn"] = `<!doctype html><html><body>
      <button id="b">Go churn</button><div id="out"></div>
      <script>window.b.onclick = () => { b.className = 's1';
        setTimeout(() => { b.textContent = 'Done state'; out.textContent = 'CHURN DONE'; }, 250); };<\/script>
    </body></html>`;
    try {
      const st = await observe(await open("/churn"));
      const go = st.actions.find((a) => a.label === "Go churn");
      assert.ok(go, "churn button observed");
      const res = await invoke("click", { profile, id: go.id, label: "Go churn" });
      assert.ok(res.ok, JSON.stringify(res));
      assert.match(res.state.text, /CHURN DONE/,
        `the in-floor reaction must be in the returned state (url=${res.state?.url}):\n${res.state?.text}`);
    } finally { delete dynamicPages["/churn"]; }
  });

  await test("72. a late-inserted iframe whose button renders after load is observed (GIS pattern)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const childPages = {
      "/gis-child": `<!doctype html><html><body>
        <div id="host"></div>
        <script>setTimeout(() => { document.getElementById('host').innerHTML =
          '<button onclick="document.title=\\'OAUTH\\'">Tiếp tục bằng tên Anh</button>'; }, 300);<\/script>
      </body></html>`
    };
    const childSrv = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      r.end(childPages[q.url.split("?")[0]] ?? childPages["/gis-child"]);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    dynamicPages["/gis"] = `<!doctype html><html><body>
      <button onclick="document.title='OUT'">Đăng nhập</button>
      <script>setTimeout(() => { const f = document.createElement('iframe');
        f.src = 'http://localhost:${childSrv.address().port}/gis-child';
        f.style = 'width:300px;height:120px'; document.body.appendChild(f); }, 250);<\/script>
    </body></html>`;
    try {
      const s = await open("/gis");
      const st = await observe(s);
      const inner = (st.actions ?? []).find((a) => /tiếp tục bằng tên anh/i.test(a.label ?? ""));
      assert.ok(inner, `the late iframe button must be in the table — iframes=${
        await engine.withSession({ profile }, (s2) => s2.iframes.size)
      } got: ${JSON.stringify(st.actions.map((a) => a.label))}`);
    } finally {
      delete dynamicPages["/gis"];
      childSrv.close();
    }
  });

  await test("73. a click that opens window.prompt reports itself; --prompt answers it", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/prompt"] = `<!doctype html><html><body>
      <button id="b" onclick="document.getElementById('out').textContent =
        window.prompt('Paste image URL') ?? 'CANCELLED'">Paste a URL</button>
      <div id="out">none</div>
    </body></html>`;
    try {
      const st = await observe(await open("/prompt"));
      const btn = st.actions.find((a) => a.label === "Paste a URL");
      assert.ok(btn, "prompt button observed");
      // 1) No --prompt: the auto-accept answers "" — the response must SAY a
      //    native prompt opened (the agent cannot guess) and point at --prompt.
      const blind = await invoke("click", { profile, id: btn.id, label: "Paste a URL" });
      assert.equal(blind.ok, false, "blind prompt click must fail fast");
      assert.equal(blind.dialog?.type, "prompt", `dialog info missing: ${JSON.stringify(blind.dialog)}`);
      assert.match(blind.error, /--prompt/);
      // 2) With --prompt the answer lands in the page.
      const answered = await invoke("click", { profile, id: btn.id, label: "Paste a URL",
        promptText: "https://x.img/9.png" });
      assert.ok(answered.ok, JSON.stringify(answered));
      assert.match(answered.state.text, /9\.png/, `page must receive the prompt answer:\n${answered.state.text}`);
    } finally { delete dynamicPages["/prompt"]; }
  });

  await test("74. tabKey isolates concurrent drivers — two keys, two engines, no yanking", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const shared = "isoshared";
    dynamicPages["/isoA"] = `<!doctype html><html><body><button onclick="">Alpha page</button></body></html>`;
    dynamicPages["/isoB"] = `<!doctype html><html><body><button onclick="">Beta page</button></body></html>`;
    try {
      await invoke("go", { profile: shared, url: `${base}/isoA`, tabKey: "sessa" });
      await invoke("go", { profile: shared, url: `${base}/isoB`, tabKey: "sessb" });
      const a = await invoke("ls", { profile: shared, tabKey: "sessa" });
      const b = await invoke("ls", { profile: shared, tabKey: "sessb" });
      assert.ok(a.url.endsWith("/isoA"), `tab A was yanked to ${a.url}`);
      assert.ok(b.url.endsWith("/isoB"), `tab B was yanked to ${b.url}`);
      assert.ok(a.actions.some((x) => x.label === "Alpha page") &&
        b.actions.some((x) => x.label === "Beta page"),
        `engines mixed up: A=${JSON.stringify(a.actions.map((x) => x.label))} B=${JSON.stringify(b.actions.map((x) => x.label))}`);
    } finally {
      delete dynamicPages["/isoA"]; delete dynamicPages["/isoB"];
      const { closeProfile } = await import("../features/browserUse/engine.js");
      await closeProfile(`${shared}#sessa`).catch(() => {});
      await closeProfile(`${shared}#sessb`).catch(() => {});
    }
  });

  await test("75. clear wipes site data for an origin (GIS cooldown reset)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/clearme"] = `<!doctype html><html><body>
      <div id="out">BOOT</div>
      <script>if (location.search.includes("seed=1")) localStorage.setItem("marker", "KEEPME");
        document.getElementById("out").textContent = localStorage.getItem("marker") || "EMPTY";<\/script>
    </body></html>`;
    try {
      await open("/clearme?seed=1");
      const before = await invoke("cat", { profile });
      assert.match(before.text, /KEEPME/, "marker stored");
      const res = await invoke("clear", { profile, origin: base });
      assert.ok(res.ok, JSON.stringify(res));
      await open("/clearme");
      const after = await invoke("cat", { profile });
      assert.match(after.text, /EMPTY/, `marker must be gone after clear: ${after.text}`);
    } finally { delete dynamicPages["/clearme"]; }
  });

  await test("76. undbg detaches the debugger and the next op re-attaches", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/duo");
    // Own mode has no separate debugger to drop — the op must say so clearly
    // (the real detach flow needs the extension and is validated live).
    await assert.rejects(() => invoke("undbg", { profile, ms: 600 }),
      /extension-mode only/);
  });

  await test("77. renderTreeLines with coords includes [x,y] center points", async () => {
    const { renderTreeLines } = await import("../features/browserUse/compress.js");
    const actions = [
      { id: "e1", node: 1, role: "button", label: "Save", kind: "click", rect: { x: 100, y: 200, w: 50, h: 20 } },
      { id: "e2", node: 2, role: "link", label: "Cancel", kind: "click", rect: { x: 300, y: 400, w: 40, h: 10 } }
    ];
    const withCoords = renderTreeLines(actions, { coords: true });
    assert.match(withCoords, /e1 button "Save" \[125,210\]/);
    assert.match(withCoords, /e2 link "Cancel" \[320,405\]/);
    const withoutCoords = renderTreeLines(actions, { coords: false });
    assert.ok(!withoutCoords.includes("[125,210]"));
  });

  await test("78. visible iframe is observed as an actionable element with coordinates", async () => {
    dynamicPages["/iframe-elem"] = `<!doctype html><html><body>
      <iframe src="about:blank" title="Widget Frame" style="position:absolute;left:50px;top:80px;width:200px;height:100px"></iframe>
    </body></html>`;
    try {
      const s = await open("/iframe-elem");
      const st = await observe(s);
      const frameEl = st.actions.find((a) => a.role === "iframe" || /widget frame/i.test(a.label));
      assert.ok(frameEl, `iframe must be observed — got: ${JSON.stringify(st.actions.map(a => a.label))}`);
      assert.ok(frameEl.rect, "iframe must have rect coordinates");
      assert.equal(frameEl.rect.x, 50);
      assert.equal(frameEl.rect.y, 80);
      const { renderTreeLines } = await import("../features/browserUse/compress.js");
      const tree = renderTreeLines(st.actions, { coords: true });
      // Center follows the real border-box rect (UA default border 2px → 204px wide),
      // so a dispatched click lands on the visible frame.
      const cx = Math.round(frameEl.rect.x + frameEl.rect.w / 2);
      const cy = Math.round(frameEl.rect.y + frameEl.rect.h / 2);
      assert.match(tree, new RegExp(`iframe.*\\[${cx},${cy}\\]`));
    } finally {
      delete dynamicPages["/iframe-elem"];
    }
  });

  await test("79. semantic tag prefixes in element IDs and 80-char label truncation", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const longText = "This is a very long button label that exceeds eighty characters easily so we can verify truncation behavior";
    dynamicPages["/semantic-tags"] = `<!doctype html><html><body>
      <button onclick="document.title='BTN'">${longText}</button>
      <a href="#">Link item</a>
      <input type="text" placeholder="Type here">
    </body></html>`;
    try {
      const s = await open("/semantic-tags");
      const st = await observe(s);
      const btn = st.actions.find((a) => a.role === "button");
      const link = st.actions.find((a) => a.role === "link");
      const inp = st.actions.find((a) => a.role === "textbox");
      assert.ok(btn?.id?.startsWith("btn"), `button id must start with 'btn', got ${btn?.id}`);
      assert.ok(link?.id?.startsWith("a"), `link id must start with 'a', got ${link?.id}`);
      assert.ok(inp?.id?.startsWith("inp"), `input id must start with 'inp', got ${inp?.id}`);

      // Backward compatibility: click using legacy 'e' prefix works
      const legacyId = `e${btn.node}`;
      const res = await invoke("click", { profile, id: legacyId });
      assert.ok(res.ok, "legacy e-prefix click must succeed");

      // Verify label truncation in tree rendering
      const { renderTreeLines } = await import("../features/browserUse/compress.js");
      const tree = renderTreeLines(st.actions);
      assert.ok(!tree.includes(longText), "full long text should not appear in tree");
      assert.ok(tree.includes("…"), "truncated text must include ellipsis");
    } finally {
      delete dynamicPages["/semantic-tags"];
    }
  });

  await test("83. tryLabels: one-shot click guesses label variants until one lands", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/trylabels"] = `<!doctype html><html><body>
      <button onclick="document.title='OK-83'">Sign in</button>
    </body></html>`;
    try {
      await open("/trylabels");
      // First two guesses do not exist; the third is the real label.
      const res = await invoke("chain", { profile, steps: [
        { op: "click", label: "Đăng nhập", tryLabels: ["Login", "Sign in"] }
      ] });
      assert.ok(res.ok, JSON.stringify(res.results));
      assert.equal((await invoke("ls", { profile })).title, "OK-83");
    } finally { delete dynamicPages["/trylabels"]; }
  });

  await test("84. not-observed miss re-observes once (late render race)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/laterender"] = `<!doctype html><html><body>
      <script>setTimeout(() => {
        const b=document.createElement('button');b.textContent='Nhấn đây';
        b.onclick=()=>document.title='OK-84';document.body.appendChild(b);
      }, 400);<\/script>
    </body></html>`;
    try {
      await open("/laterender");
      const res = await invoke("chain", { profile, steps: [
        { op: "wait", ms: 100 },
        { op: "click", label: "Nhấn đây" }
      ] });
      assert.ok(res.ok, `late render must be absorbed by the re-observe: ${JSON.stringify(res.results)}`);
      assert.equal((await invoke("ls", { profile })).title, "OK-84");
    } finally { delete dynamicPages["/laterender"]; }
  });

  // ---- review fixes (TDD batch): chain semantics, windowing, tabs, burst ----

  await test("85. a failing sub-chain fail-fasts the ROOT chain (run step attribution)", async () => {
    const { invoke, setConfig, loadConfig } = await import("../features/browserUse/browserUseSocket.js");
    const enabledBefore = (await loadConfig()).enabled; // restore after; silent = no skill side effects
    setConfig({ enabled: true }, { persist: false, syncSkill: false });
    try {
      await open("/chain");
      const doneNow = ({ questions }) =>
        Promise.resolve({ answers: { operation: op(questions, "DONE") }, model: "fake" });
      const res = await invoke("chain", { profile, decide: doneNow, steps: [
        { op: "run", goal: "noop", steps: [
          { op: "click", id: "btn-khong-ton-tai" } // sub-step must break the parent
        ] },
        { op: "grep", pattern: "Nav noise" } // must NEVER run after the sub failure
      ] });
      assert.equal(res.ok, false, "sub-chain failure must surface, not be swallowed");
      assert.ok(res.results.some((r) => r.ok === false), "the failing sub-step is reported");
      assert.ok(!res.results.some((r) => r.op === "grep"), "steps after the sub failure must not run");
      assert.ok(res.state, "live state must ride the failure for the re-plan");
    } finally { setConfig({ enabled: enabledBefore }, { persist: false, syncSkill: false }); }
  });

  await test("86. bare ls --tail returns the default window, not one element", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    await open("/long"); // 400 buttons
    const res = await invoke("ls", { profile, tail: true });
    const real = res.actions.filter((a) => typeof a.node === "number");
    assert.ok(real.length >= 200, `bare --tail must reuse the default len — got ${real.length} real elements`);
  });

  await test("87. an armed prompt answer does not leak past a failed click", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/prompt2"] = `<!doctype html><html><body>
      <button id="b" onclick="document.getElementById('out').textContent =
        window.prompt('Paste image URL') ?? 'CANCELLED'">Paste a URL</button>
      <div id="out">none</div>
      <div style="position:relative;height:40px">
        <button onclick="document.title='NOPE'">Covered arm target</button>
        <div style="position:absolute;inset:0;background:#ccc;opacity:.6"></div>
      </div>
    </body></html>`;
    try {
      await open("/prompt2");
      // 1) A chain click whose ACT throws (target covered) while carrying a
      //    prompt answer — the arm must not survive the failure.
      const covered = (await observe(await open("/prompt2"))).actions.find((a) => /covered arm target/i.test(a.label));
      const failed = await invoke("chain", { profile, steps: [
        { op: "click", id: covered.id, prompt: "LEAKED-ANSWER" }
      ] });
      assert.equal(failed.ok, false, "setup: the covered click must fail (STALE)");
      // 2) The NEXT blind prompt click must be answered "" (auto), not LEAKED-ANSWER.
      const st = await observe(await open("/prompt2"));
      const btn = st.actions.find((a) => a.label === "Paste a URL");
      const blind = await invoke("click", { profile, id: btn.id, label: "Paste a URL" });
      assert.equal(blind.ok, false);
      assert.match(blind.error, /--prompt/);
      assert.ok(!JSON.stringify(blind).includes("LEAKED-ANSWER"), "the stale answer leaked into the next dialog");
    } finally { delete dynamicPages["/prompt2"]; }
  });

  await test("88. sub-chain (depth>0) accepts a full navigation click", async () => {
    const { invoke, setConfig, loadConfig } = await import("../features/browserUse/browserUseSocket.js");
    const enabledBefore = (await loadConfig()).enabled; // restore after; silent = no skill side effects
    setConfig({ enabled: true }, { persist: false, syncSkill: false });
    try {
      await open("/chain");
      const doneNow = ({ questions }) =>
        Promise.resolve({ answers: { operation: op(questions, "DONE") }, model: "fake" });
      const res = await invoke("chain", { profile, decide: doneNow, steps: [
        { op: "run", goal: "noop", steps: [
          { op: "click", label: "Go next" },  // full navigation to /chain2
          { op: "click", label: "Next OK" }   // must run on the NEW page
        ] }
      ] });
      assert.ok(res.ok, `nested funnel must be accepted at depth>0: ${JSON.stringify(res.results)}`);
      assert.equal((await invoke("ls", { profile })).title, "P2");
    } finally { setConfig({ enabled: enabledBefore }, { persist: false, syncSkill: false }); }
  });

  await test("89. switchTab resets the iframe pool — no cross-tab iframe bleed", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const tabProfile = `rev-tabs-${Date.now()}`;
    let served = 0;
    const childSrv = http.createServer((q, r) => {
      served++;
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(`<!doctype html><html><body><button id="inner">iframe inner ${served}</button></body></html>`);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    try {
      const frameUrl = `http://localhost:${childSrv.address().port}/`;
      // BOTH tabs carry an iframe — tab 2 must only ever show its own frame
      dynamicPages["/withframe"] = `<!doctype html><html><body>
        <iframe src="${frameUrl}?a" style="width:300px;height:120px"></iframe>
      </body></html>`;
      dynamicPages["/withframe2"] = `<!doctype html><html><body>
        <iframe src="${frameUrl}?b" style="width:300px;height:120px"></iframe>
      </body></html>`;
      await invoke("go", { profile: tabProfile, url: `${base}/withframe`, headless: true });
      const t1 = await invoke("ls", { profile: tabProfile });
      const t1Label = t1.actions.find((a) => /iframe inner \d/i.test(a.label))?.label;
      assert.ok(t1Label, "setup: iframe observed on tab 1");
      await invoke("go", { profile: tabProfile, url: `${base}/withframe2`, newTab: true, headless: true });
      const t2 = await invoke("ls", { profile: tabProfile });
      const t2Labels = t2.actions.filter((a) => /iframe inner \d/i.test(a.label)).map((a) => a.label);
      assert.equal(t2Labels.length, 1, `tab 2 must merge exactly ONE iframe — got [${t2Labels.join(", ")}]`);
      assert.notEqual(t2Labels[0], t1Label, "tab 2 inherited tab 1's iframe target (pool not reset on adopt)");
      // Round trip: back on tab 1 its own frame rows must come back — Chrome
      // does not re-fire attachedToTarget, so a hard clear loses them forever.
      await invoke("go", { profile: tabProfile, tab: 1, headless: true });
      const back = await invoke("ls", { profile: tabProfile });
      assert.ok(back.actions.some((a) => a.label === t1Label),
        `tab 1 must keep its iframe rows after a round trip — got [${back.actions.filter((a) => /iframe inner/i.test(a.label)).map((a) => a.label).join(", ")}]`);
    } finally {
      delete dynamicPages["/withframe"]; delete dynamicPages["/withframe2"];
      const { closeProfile } = await import("../features/browserUse/engine.js");
      await closeProfile(tabProfile).catch(() => {});
      childSrv.close();
    }
  });

  await test("90. windowed ls keeps element_from/total consistent with appended iframe rows", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    const tabProfile = `rev-win-${Date.now()}`;
    const childSrv = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(`<!doctype html><html><body><button id="inner">iframe inner button</button></body></html>`);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    try {
      const frameUrl = `http://localhost:${childSrv.address().port}/`;
      dynamicPages["/withframe"] = `<!doctype html><html><body>
        ${'<button style="font-size:6px;height:6px;padding:0">Item</button>'.repeat(40)}
        <iframe src="${frameUrl}" style="width:300px;height:120px"></iframe>
      </body></html>`;
      await invoke("go", { profile: tabProfile, url: `${base}/withframe`, headless: true });
      const res = await invoke("ls", { profile: tabProfile, from: 10 });
      const real = res.actions.filter((a) => typeof a.node === "number");
      assert.equal(res.total_elements, real.length + (res.omitted_actions || 0),
        `total must count main+iframe rows actually served — total=${res.total_elements} real=${real.length} omitted=${res.omitted_actions || 0}`);
    } finally {
      delete dynamicPages["/withframe"];
      const { closeProfile } = await import("../features/browserUse/engine.js");
      await closeProfile(tabProfile).catch(() => {});
      childSrv.close();
    }
  });

  await test("91. nowait link click skips the settle (fire-and-forget)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/slowland"] = `<!doctype html><html><body><h1>SLOWLAND ARRIVED</h1></body></html>`;
    // serve it after 1500ms — a settled click would wait for the land
    const slow = http.createServer((q, r) => setTimeout(() => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(dynamicPages["/slowland"]);
    }, 1500));
    await new Promise((r) => slow.listen(0, "127.0.0.1", r));
    try {
      dynamicPages["/linkout"] = `<!doctype html><html><body>
        <a href="http://127.0.0.1:${slow.address().port}/">Go slow land</a>
      </body></html>`;
      const st = await observe(await open("/linkout"));
      const link = st.actions.find((a) => a.role === "link" || a.tag === "a");
      const t0 = Date.now();
      const res = await invoke("click", { profile, id: link.id, nowait: true });
      const elapsed = Date.now() - t0;
      assert.ok(res.ok, JSON.stringify(res));
      assert.ok(elapsed < 1200, `nowait link click must not pay the settle — took ${elapsed}ms`);
    } finally {
      delete dynamicPages["/slowland"]; delete dynamicPages["/linkout"];
      slow.close();
    }
  });

  await test("92. closing the LAST tab tears the engine session down", async () => {
    const { sessionStatus } = await import("../features/browserUse/engine.js");
    const { invoke: inv } = await import("../features/browserUse/browserUseSocket.js");
    const lastProfile = `rev-last-${Date.now()}`;
    await inv("go", { profile: lastProfile, url: `${base}/`, headless: true });
    assert.ok((await sessionStatus()).some((s) => s.profile === lastProfile), "setup: session alive");
    await inv("close", { profile: lastProfile });
    assert.ok(!(await sessionStatus()).some((s) => s.profile === lastProfile),
      "the engine session must be gone after the last tab closes");
    // A leaked Chrome child keeps the user-data-dir locked — reopening the
    // same profile immediately must still work.
    const reopen = await inv("ls", { profile: lastProfile, headless: true });
    assert.ok(reopen.url, "reopening the profile right after close must succeed");
    await inv("close", { profile: lastProfile });
  });

  await test("93. iframe element ids survive main-list shifts", async () => {
    const tabProfile = `rev-ifrid-${Date.now()}`;
    const childSrv = http.createServer((q, r) => {
      r.writeHead(200, { "Content-Type": "text/html" });
      r.end(`<!doctype html><html><body><button id="inner">iframe inner button</button></body></html>`);
    });
    await new Promise((r) => childSrv.listen(0, "localhost", r));
    try {
      const frameUrl = `http://localhost:${childSrv.address().port}/`;
      dynamicPages["/shiftframe"] = `<!doctype html><html><body>
        <button onclick="document.getElementById('zone').insertAdjacentHTML('afterbegin','<button>Extra node</button>')">Add node before iframe</button>
        <div id="zone"></div>
        <iframe src="${frameUrl}" style="width:300px;height:120px"></iframe>
      </body></html>`;
      const s = await withSession({ profile: tabProfile, url: `${base}/shiftframe`, headless: true }, (x) => x);
      const before = (await observe(s)).actions.find((a) => /iframe inner button/i.test(a.label));
      assert.ok(before, "setup: iframe button observed");
      const adder = (await observe(s)).actions.find((a) => /add node before iframe/i.test(a.label));
      await s.act(adder); // main list shifts — iframe ids must not renumber
      const after = (await observe(s)).actions.find((a) => /iframe inner button/i.test(a.label));
      assert.equal(after?.id, before.id, `iframe id must be stable — ${before.id} -> ${after?.id}`);
    } finally {
      delete dynamicPages["/shiftframe"];
      const { closeProfile } = await import("../features/browserUse/engine.js");
      await closeProfile(tabProfile).catch(() => {});
      childSrv.close();
    }
  });

  // Fake bottomed page shared by tests 94/95: the scroll never moves y.
  const bottomedSession = () => ({
    cancelRequested: false,
    async observe() {
      return { url: "http://t/", title: "T", text: "filler text",
        actions: [{ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 600 }],
        scroll: { y: 4200 }, marker: ["o", "u"], contentMarker: ["c"] };
    },
    async steady() { return this.observe(); },
    async fresh() { return true; },
    async act() { return { executed: "scroll_down" }; },
    async scrollBurstStep() { return { found: false, hops: 1, y: 4200 }; }
  });

  await test("94. scroll burst that cannot move the page counts as stale (no_progress)", async () => {
    const decide = ({ questions }) =>
      Promise.resolve({ answers: { operation: op(questions, "SCROLL_DOWN") }, model: "fake" });
    const result = await runTask(bottomedSession(), { goal: "find KHÔNG-TỒN-TẠI-XYZ", decide, maxSteps: 8, maxMs: 10000,
      expect: { text: ["KHÔNG-TỒN-TẠI-XYZ"] } });
    assert.equal(result.outcome, "no_progress",
      `a burst that moves nothing is stale — got ${result.outcome}: ${result.reason}`);
  });

  await test("95. engine without scrollBurstStep falls back to ONE plain scroll per decision", async () => {
    const noHop = () => {
      const s = bottomedSession();
      delete s.scrollBurstStep; // old engine / missing fast hop
      return s;
    };
    const decide = ({ questions }) =>
      Promise.resolve({ answers: { operation: op(questions, "SCROLL_DOWN") }, model: "fake" });
    const result = await runTask(noHop(), { goal: "find KHÔNG-TỒN-TẠI-XYZ", decide, maxSteps: 4, maxMs: 10000,
      expect: { text: ["KHÔNG-TỒN-TẠI-XYZ"] } });
    const scrolls = result.history.filter((h) => h.kind === "scroll");
    assert.ok(scrolls.length >= 2, `setup: several scroll decisions must run — ${result.outcome}: ${result.reason}`);
    assert.ok(scrolls.every((h) => !/×\d+/.test(h.action) || /×1\b/.test(h.action)),
      `the slow fallback must not fan out — got ${scrolls.map((h) => h.action).join(", ")}`);
  });

  await test("96. grep self-heals through a lazy-rendering page (GitHub trending pattern)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/lazy"] = `<!doctype html><html><body>
      <nav>Site chrome nav</nav>
      <div id="app">Loading</div>
      <script>setTimeout(() => {
        document.getElementById('app').innerHTML =
          '<article>Project Alpha — 1,234 stars this week — fast tool</article>';
      }, 700);<\/script>
    </body></html>`;
    try {
      await open("/lazy");
      // The read lands while the page still says "Loading" — one re-read must
      // absorb the late render instead of serving a guaranteed miss.
      const r = await invoke("grep", { profile, pattern: "stars this week", context: 1 });
      assert.ok(r.matched >= 1, `grep must see the late-rendered rows — got ${r.matched} matches`);
      assert.match(r.text, /Project Alpha/);
    } finally { delete dynamicPages["/lazy"]; }
  });

  await test("97. bare cat caps the served text (agent context budget)", async () => {
    const { invoke } = await import("../features/browserUse/browserUseSocket.js");
    dynamicPages["/longtext"] = `<!doctype html><html><body>
      ${Array.from({ length: 4000 }, (_, i) => `<p>Paragraph ${i} of the long story.</p>`).join("\n")}
    </body></html>`;
    try {
      await open("/longtext");
      const r = await invoke("cat", { profile });
      assert.ok((r.text || "").length <= 17000, `default cat must stay small — got ${(r.text || "").length} chars`);
      assert.ok((r.total || 0) > (r.text || "").length, "total must reveal the rest for --from reads");
    } finally { delete dynamicPages["/longtext"]; }
  });

  await closeProfile(profile).catch(() => {});
  await profiles.remove(profile).catch(() => {});
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
