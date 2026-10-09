// TDD suite for LONG real-world journeys — the one-shot metric: a task finishes
// in ONE chain, or breaks fast at the exact wrong step and ONE pending-derived
// repair chain finishes it (hard cap: 2 calls per task). Engine under test:
// read auto-scope (sole <article>/<main>), parent needle >40 chars, default
// read bound. Real Chrome headless + local fixtures, fake Jev offline.
// Run: node host/test/browserOneShotLong.test.mjs   (CASES=1,7 to subset)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TEST_PROFILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-test-oneshot-long-"));
process.env.NREMOTE_BROWSER_PROFILES_DIR = TEST_PROFILES_DIR;
process.on("exit", () => {
  try { fs.rmSync(TEST_PROFILES_DIR, { recursive: true, force: true }); } catch {}
});

import { invoke, setConfig } from "../features/browserUse/browserUseSocket.js";

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
// Every fixture mimics the noisy real web: nav chrome, sidebars, related links
// around the one element a user actually asked about. Listing anchors sit in
// <p> blocks — the shape real listings use (vnexpress, shops, docs indexes).
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`;
const nav = `<nav>NAV-NOISE home · news · sports · video · radio</nav>`;
const aside = `<aside><h3>Tin cùng chủ đề</h3><p><a href="/news/story-1">Bài liên quan một</a></p><p><a href="/news/story-2">Bài liên quan hai</a></p></aside>`;

// Story titles run well past the 40-char section-name cap — exactly the trap
// a model hits when it pastes a full headline into read parent:"…".
const TITLES = [
  "Cô phi công em dâu dãi nước mưa tìm thấy người chồng không còn sống ở phòng trọ giá rẻ",
  "Bạn gái người cũ lần cuối trước lễ ăn hỏi cùng tác trọc lê anh mà cảm thấy xinh hân",
  "Mẹ chồng khuyên tôi buông tay vì quá hiểu tính con trai bà và người thứ ba xuất hiện",
  "Bạn trai yêu người xinh đẹp hơn tôi nhưng vẫn đến một đám cưới anh đã hứa từ lâu",
  "Tôi ngại tình đã biến vợ thành người khác sau ba năm chung sống khắc nhất"
];
const story = (i) => page(`${nav}
  <article><h1>${TITLES[i]}</h1>
    ${Array.from({ length: 12 }, (_, k) => `<p>PARA-${i + 1}-${k + 1} Nội dung đoạn văn thứ ${k + 1} của bài báo số ${i + 1}.</p>`).join("\n    ")}
  </article>${aside}`);

const longLines = Array.from({ length: 300 }, (_, k) => `    <p>LONG-LINE-${k + 1} dòng dài số ${k + 1} của trang đọc dài để thử biên mặc định.</p>`).join("\n");

const PAGES = {
  "/news": page(`${nav}
    <section aria-label="Latest stories"><h2>Tâm sự mới nhất</h2>
      ${TITLES.map((t, i) => `<p><a href="/news/story-${i + 1}">${t}</a></p>`).join("\n      ")}
    </section>${aside}`),
  "/news/story-1": story(0), "/news/story-2": story(1), "/news/story-3": story(2),
  "/news/story-4": story(3), "/news/story-5": story(4),
  // A 300-paragraph read: the DEFAULT read bound must keep it in the response
  // and say how much was cut, or one long page costs the agent 2 extra turns.
  "/longread": page(`${nav}<article><h1>Trường ca không kết thúc của một người đọc dài</h1>\n${longLines}</article>${aside}`),
  // Docs site: huge sidebar noise around <main> content on every page.
  "/docs": page(`${nav}<div style="float:left;width:200px">DOC-NAV-NOISE config deploy billing limits</div>
    <main><h1>Docs home</h1><p><a href="/docs/config">Configuration reference</a></p><p><a href="/docs/deploy">Deployment guide</a></p></main>`),
  "/docs/config": page(`${nav}<div style="float:left;width:200px">DOC-NAV-NOISE config deploy billing limits</div>
    <main><h1>Configuration</h1><p>The <code>maxWorkers</code> flag defaults to 8.</p></main>`),
  "/docs/deploy": page(`${nav}<div style="float:left;width:200px">DOC-NAV-NOISE config deploy billing limits</div>
    <main><h1>Deployment</h1><p>Set <code>deploy_timeout</code> default 30s.</p></main>`),
  // Shop: listing of 3 products, each detail page carries PRICE-N in <article>.
  "/shop": page(`${nav}<main><h1>Sản phẩm</h1>
    <p><a href="/shop/p-1">Áo khoác</a></p><p><a href="/shop/p-2">Giày chạy</a></p><p><a href="/shop/p-3">Túi da</a></p></main>${aside}`),
  "/shop/p-1": page(`${nav}<article><h1>Áo khoác</h1><p>PRICE-1 1.250.000₫</p><p>Còn hàng</p></article>${aside}`),
  "/shop/p-2": page(`${nav}<article><h1>Giày chạy</h1><p>PRICE-2 980.000₫</p><p>Hết hàng</p></article>${aside}`),
  "/shop/p-3": page(`${nav}<article><h1>Túi da</h1><p>PRICE-3 2.100.000₫</p><p>Còn hàng</p></article>${aside}`),
  // Search funnel: form submit (full nav) -> results -> detail page.
  "/sform": page(`<form action="/sres" method="get"><input name="q" placeholder="Tìm"></form>`),
  "/sres": (q) => page(`<h1>Kết quả cho ${q}</h1><p><a href="/sdetail">Top result</a></p>`),
  "/sdetail": page(`<main><h1>Chi tiết</h1><p>ANSWER-7 đây là đáp án cần trích.</p></main>`),
  // Cookie wall + login: the unknown-label segment a chain must delegate.
  "/gate": page(`
    <div id="ck"><button onclick="document.getElementById('ck').remove()">Chấp nhận cookie</button></div>
    <p>Trang đăng nhập</p>
    <div id="s1">
      <input placeholder="Email"><input type="password" placeholder="Password">
      <button onclick="document.getElementById('s1').style.display='none';document.getElementById('s2').style.display='block'">Đăng nhập</button>
    </div>
    <div id="s2" style="display:none"><h2>Bảng điều khiển</h2><p>WELCOME-8 xin chào admin</p></div>`),
  // Paginated listing: page 1 -> Next -> page 2 items.
  "/list": page(`${nav}<main><h1>Trang 1</h1><p><a href="/list2">Trang sau</a></p></main>`),
  "/list2": page(`${nav}<main><h1>Trang 2</h1><p>PAGE2-ITEM mục thứ hai</p></main>`),
  // Long wizard with a detour: one wrong label planted mid-way.
  "/wz": page(`
    <div id="w1"><input placeholder="Tên dự án"><button onclick="w(1)">Tiếp</button></div>
    <div id="w2" style="display:none"><input placeholder="Mô tả"><button onclick="w(2)">Tiếp</button></div>
    <div id="w3" style="display:none"><select onchange="document.title='SIZE:'+this.value"><option value="">Chọn size</option><option value="xl">xl</option></select><button onclick="w(3)">Tiếp</button></div>
    <div id="w4" style="display:none"><button onclick="w(4)">Hoàn tất</button></div>
    <div id="done" style="display:none"><h2>WZ-COMPLETE</h2><p>WZ-RECEIPT mã biên nhận 77</p></div>
    <script>function w(n){document.getElementById('w'+n).style.display='none';document.getElementById('w'+(n+1)).style.display='block'}<\/script>`)
};

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
    res.end(typeof entry === "function" ? entry(u.searchParams.get("q") ?? "") : (entry || PAGES["/news"]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = Date.now();
  for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) profiles.create(`long-${n}-${stamp}`);
  const chain = (profile, steps, extra = {}) => invoke("chain", { profile, steps, ...extra });
  const cleanup = async (profile) => { await profiles.remove(profile).catch(() => {}); };
  const failures = (res) => JSON.stringify(res.results?.filter((r) => !r.ok) ?? res);

  // 1. NEWS DIGEST — the exact user case this whole suite exists for: 5 newest
  //    stories, each summarized. ONE chain: listing links + 5x(go+read). The
  //    bare read must auto-scope to the article (no NAV/side noise).
  await test("1. news digest: 5 stories read clean+bounded in ONE chain (12 steps)", async () => {
    const profile = `long-1-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/news` },
        { op: "search", pattern: "story-", links: true },
        ...[1, 2, 3, 4, 5].flatMap((i) => [
          { op: "go", url: `${base}/news/story-${i}` },
          { op: "read" }
        ])
      ], { goal: "digest the 5 newest stories" });
      assert.equal(res.ok, true, failures(res));
      assert.equal(res.results.length, 12, "all 12 steps in one shot");
      const reads = res.results.filter((r) => r.op === "read");
      assert.equal(reads.length, 5);
      reads.forEach((r, i) => {
        assert.ok(r.text.includes(`PARA-${i + 1}-1`), `read ${i + 1} carries the story body`);
        assert.ok(!r.text.includes("NAV-NOISE"), `read ${i + 1} auto-scoped past the nav`);
        assert.ok(!r.text.includes("Bài liên quan"), `read ${i + 1} auto-scoped past the sidebar`);
      });
    } finally { await cleanup(profile); }
  });

  // 2. LONG PARENT NAME — a full headline (>40 chars) must still select its
  //    article; a miss is a fail-fast break whose ONE pending-derived repair
  //    finishes the job. Cap: 2 calls.
  await test("2. parent needle >40 chars: matches (or breaks fast + ONE pending repair)", async () => {
    const profile = `long-2-${stamp}`;
    try {
      let calls = 0;
      let res = await chain(profile, [
        { op: "go", url: `${base}/news/story-3` },
        { op: "read", parent: TITLES[2] },
        { op: "search", pattern: "PARA-3-1" }
      ], { goal: "read story 3 body" });
      calls++;
      if (!res.ok) {
        assert.equal(res.failedStep, 2, "break is AT the parent read, nothing later ran");
        assert.deepEqual(res.pending, [{ op: "search", pattern: "PARA-3-1" }], "pending carries the owed remainder");
        res = await chain(profile, [
          { op: "read", parent: TITLES[2].slice(0, 40) },
          ...res.pending
        ], { goal: "read story 3 body" });
        calls++;
      }
      assert.equal(calls, 1, "a full-length headline must select its article outright, no repair needed");
      assert.equal(res.ok, true, failures(res));
      const read = res.results.find((r) => r.op === "read");
      assert.ok(read.text.includes("PARA-3-1"), "the long-named section was selected");
    } finally { await cleanup(profile); }
  });

  // 3. DEFAULT READ BOUND — a 300-paragraph page must come back bounded with a
  //    marker saying how much was cut; a follow-up read with head reaches the
  //    tail. The bound is what lets 5 full reads share ONE chain response.
  await test("3. 300-line read comes back bounded + says what was cut", async () => {
    const profile = `long-3-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/longread` },
        { op: "read" }
      ]);
      assert.equal(res.ok, true, failures(res));
      const read = res.results.find((r) => r.op === "read");
      const lines = read.text.split("\n").filter(Boolean);
      assert.ok(lines.length <= 60, `default bound caps lines (got ${lines.length})`);
      assert.match(read.summary, /\+\d+ more/, "summary names the cut tail");
      // Continuation: from= windows past the page-level cap to the real tail.
      const deep = await chain(profile, [{ op: "read", from: 11000 }]);
      assert.ok(deep.results[0].text.includes("LONG-LINE-300"), "from= reaches the tail on demand");
    } finally { await cleanup(profile); }
  });

  // 4. DOCS LOOKUP — 2-shot shape: call 1 harvests the section links, call 2
  //    visits BOTH pages and greps both flags. Cap: 2 calls.
  await test("4. docs: link harvest shot + one shot covering both pages", async () => {
    const profile = `long-4-${stamp}`;
    try {
      let calls = 0;
      const scout = await chain(profile, [
        { op: "go", url: `${base}/docs` },
        { op: "search", pattern: "docs/", links: true }
      ], { goal: "find the config + deploy flags" });
      calls++;
      assert.equal(scout.ok, true, failures(scout));
      assert.ok(scout.results[1].matched >= 2, "link harvest found both doc pages");
      const res = await chain(profile, [
        { op: "go", url: `${base}/docs/config` },
        { op: "search", pattern: "maxWorkers", context: 1 },
        { op: "go", url: `${base}/docs/deploy` },
        { op: "search", pattern: "deploy_timeout", context: 1 }
      ], { goal: "find the config + deploy flags" });
      calls++;
      assert.equal(calls, 2, "docs lookup is a 2-call task, not a per-page crawl");
      assert.equal(res.ok, true, failures(res));
      const searches = res.results.filter((r) => r.op === "search");
      assert.ok(searches[0].text.includes("8"), "config flag quoted");
      assert.ok(searches[1].text.includes("30s"), "deploy flag quoted");
    } finally { await cleanup(profile); }
  });

  // 5. SHOP SWEEP — 3 products, price each: harvest + ONE chain of 3x(go+search).
  await test("5. shop: price 3 products in 2 calls total", async () => {
    const profile = `long-5-${stamp}`;
    try {
      let calls = 0;
      const scout = await chain(profile, [
        { op: "go", url: `${base}/shop` },
        { op: "search", pattern: "shop/p-", links: true }
      ]);
      calls++;
      assert.ok(scout.results[1].matched >= 3, "listing links harvested");
      const res = await chain(profile, [1, 2, 3].flatMap((i) => [
        { op: "go", url: `${base}/shop/p-${i}` },
        { op: "search", pattern: `PRICE-${i}`, context: 1 }
      ]));
      calls++;
      assert.equal(calls, 2, "no per-product calls");
      assert.equal(res.ok, true, failures(res));
      assert.ok(res.results.filter((r) => r.op === "search").every((r) => r.matched >= 1), "all 3 prices in");
    } finally { await cleanup(profile); }
  });

  // 6. SEARCH FUNNEL — form submit crosses a full navigation, then a declared
  //    link, then a grep: all inside ONE chain.
  await test("6. search engine funnel: type+enter -> top result -> answer, ONE chain", async () => {
    const profile = `long-6-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/sform` },
        { op: "type", label: "Tìm", text: "câu hỏi", enter: true },
        { op: "click", label: "Top result", nav: true },
        { op: "search", pattern: "ANSWER-7", context: 1 }
      ]);
      assert.equal(res.ok, true, failures(res));
      assert.ok(res.results[3].matched >= 1, "answer extracted in the same shot");
    } finally { await cleanup(profile); }
  });

  // 7. COOKIE WALL + LOGIN — the unknown-label segment goes to a delegated run
  //    (fake offline Jev), the rest of the journey plans straight past it.
  await test("7. cookie wall via run + login + verify, ONE chain", async () => {
    const profile = `long-7-${stamp}`;
    const wasEnabled = (await invoke("config.get")).config.enabled;
    setConfig({ enabled: true }, { persist: false, syncSkill: false });
    const mk = (criteria, choice) => {
      const probabilities = {}; for (const k of Object.keys(criteria)) probabilities[k] = k === choice ? 1 : 0;
      return { choice, confidence: 1, probabilities };
    };
    const fakeDecide = async ({ questions }) => {
      const click = questions.click_target;
      const hit = click && Object.entries(click.criteria).find(([, v]) => /chấp nhận cookie|đăng nhập/i.test(String(v)));
      if (hit) return { answers: { operation: mk(questions.operation.criteria, "CLICK"), click_target: mk(click.criteria, hit[0]) } };
      const type = questions.type_text_target;
      const t = type && Object.entries(type.criteria).find(([, v]) => /email|password/i.test(String(v)));
      if (t) return { answers: { operation: mk(questions.operation.criteria, "TYPE_TEXT"), type_text_target: mk(type.criteria, t[0]) } };
      return { answers: { operation: mk(questions.operation.criteria, "DONE") } };
    };
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/gate` },
        { op: "run", goal: "dismiss the cookie banner", expectText: ["Trang đăng nhập"] },
        { op: "type", label: "Email", text: "me@x.co" },
        { op: "type", label: "Password", text: "hunter2" },
        { op: "click", label: "Đăng nhập" },
        { op: "search", pattern: "WELCOME-8", context: 1 }
      ], { decide: fakeDecide });
      assert.equal(res.ok, true, failures(res));
      assert.ok(res.results.find((r) => r.op === "search").matched >= 1, "post-login greeting found");
    } finally { setConfig({ enabled: wasEnabled }, { persist: false, syncSkill: false }); await cleanup(profile); }
  });

  // 8. PAGINATION — cross to page 2 via a declared link, read there: ONE chain.
  await test("8. pagination: page 1 -> next -> page 2 content, ONE chain", async () => {
    const profile = `long-8-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/list` },
        { op: "click", label: "Trang sau", nav: true },
        { op: "search", pattern: "PAGE2-ITEM", context: 1 }
      ]);
      assert.equal(res.ok, true, failures(res));
      assert.ok(res.results[2].matched >= 1, "page-2 item read in the same shot");
    } finally { await cleanup(profile); }
  });

  // 9. FAIL FAST + ONE REPAIR — a multi-step wizard with one planted wrong
  //    label: the chain must die exactly there, hand back pending, and the
  //    SINGLE repair shot (pending, fixed) completes the journey. Cap: 2 calls.
  await test("9. 9-step wizard, one wrong guess: exact break + ONE pending repair", async () => {
    const profile = `long-9-${stamp}`;
    const tail = [
      { op: "click", label: "Tiếp" }, // w2 -> w3
      { op: "select", label: "xl" },
      { op: "click", label: "Tiếp" }, // w3 -> w4
      { op: "click", label: "Hoàn tất" },
      { op: "search", pattern: "WZ-RECEIPT" },
      { op: "find", pattern: "WZ-COMPLETE" }
    ];
    try {
      let calls = 0;
      let res = await chain(profile, [
        { op: "go", url: `${base}/wz` },
        { op: "type", label: "Tên dự án", text: "app" },
        { op: "click", label: "Tiếp" },
        { op: "type", label: "Mô tả KHÔNG TỒN TẠI", text: "mô tả" }, // planted miss at step 4
        ...tail
      ], { goal: "finish the wizard and grab the receipt" });
      calls++;
      assert.equal(res.ok, false, "the planted miss must break the chain");
      assert.equal(res.failedStep, 4, `break is at the miss (got ${res.failedStep})`);
      assert.deepEqual(res.pending, tail, "pending = the untouched remainder, copy-paste ready");
      res = await chain(profile, [
        { op: "type", label: "Mô tả", text: "mô tả" },
        ...res.pending
      ], { goal: "finish the wizard and grab the receipt" });
      calls++;
      assert.ok(calls <= 2, `one-shot metric: ${calls} calls`);
      assert.equal(res.ok, true, failures(res));
      assert.ok(res.results.find((r) => r.op === "search").matched >= 1, "receipt found by the repair shot");
    } finally { await cleanup(profile); }
  });

  // 10. BUDGET GUARD — the whole point of the default read bound: 5 story reads
  //     in ONE chain response must stay small enough that no harness ever
  //     persists the output to a file (32KB class). Measured, not vibes.
  await test("10. 5 full reads in one chain stay under the persist threshold", async () => {
    const profile = `long-10-${stamp}`;
    try {
      const res = await chain(profile, [
        { op: "go", url: `${base}/news` },
        ...[1, 2, 3, 4, 5].flatMap((i) => [
          { op: "go", url: `${base}/news/story-${i}` },
          { op: "read" }
        ])
      ]);
      assert.equal(res.ok, true, failures(res));
      const total = res.results.reduce((n, r) => n + (r.text?.length ?? 0), 0);
      assert.ok(total < 24000, `5 bounded reads total ${total} chars (< 24KB)`);
    } finally { await cleanup(profile); }
  });

  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
