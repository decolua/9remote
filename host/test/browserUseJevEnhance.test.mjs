// TDD + benchmark: prompt enhancements for Jev (expect-gated DONE, DONE inside
// the micro-plan, will-type on TYPE_TEXT criteria) across hard multilingual
// cases. Run: node host/test/browserUseJevEnhance.test.mjs
// Offline part pins the transforms; JEV_BENCH=1 runs the real-Jev comparison
// (default OpenRouter lane, same schema as the live loop).
import assert from "node:assert/strict";
import { buildActionSpace, buildQuestions } from "../features/browserUse/agentLoop.js";
import { decide, validateChoice } from "../features/browserUse/jevClient.js";

// ---- variant transforms (pure — candidates for agentLoop, not wired yet) -----

function withExpect(body, expect) {
  if (!expect || !expect.text?.length) return body;
  const clone = structuredClone(body);
  const wanted = (Array.isArray(expect.text) ? expect.text : [expect.text]).join(" / ");
  clone.questions.operation.criteria.DONE =
    `${clone.questions.operation.criteria.DONE} Requires the page visibly showing: "${wanted}".`;
  return clone;
}

function withMicroDone(body, expect) {
  const clone = structuredClone(body);
  const wanted = expect?.text?.length
    ? ` Requires the page visibly showing: "${(Array.isArray(expect.text) ? expect.text : [expect.text]).join(" / ")}".` : "";
  for (const key of ["step_2", "step_3"]) {
    const q = clone.questions[key];
    if (q && !q.criteria.DONE) {
      q.criteria.DONE = `Every remaining requirement is already satisfied — stop here, run nothing else.${wanted}`;
    }
  }
  return clone;
}

function withWillType(body, space) {
  const clone = structuredClone(body);
  const q = clone.questions.type_text_target;
  if (!q) return clone;
  const texts = space.targets.TYPE_TEXT || {};
  for (const [id, entry] of Object.entries(q.criteria)) {
    const text = texts[id]?.text;
    if (text) entry.element = `${entry.element} — will type: "${String(text).slice(0, 40)}"`;
  }
  return clone;
}

// Split the DONE gate into its own binary question: completion is judged on
// goal + page evidence alone, never competing with the element table for
// probability mass. The operation question keeps only real operations.
function withDoneSplit(body) {
  const clone = structuredClone(body);
  const ops = clone.questions.operation;
  clone.questions.done_check = {
    type: "choice",
    criteria: {
      DONE: ops.criteria.DONE,
      CONTINUE: "At least one required action or page state is still missing — keep going."
    },
    instructions: ops.instructions
  };
  delete ops.criteria.DONE;
  return clone;
}

// Simulates calls 2..N of a "tree on first call only" run: the state loses the
// tree; criteria (labels + ctx) and recent_actions are all the model gets.
function withNoTree(body) {
  const clone = structuredClone(body);
  delete clone.state.page.tree;
  return clone;
}

const VARIANTS = {
  "baseline": (body) => body,
  "+expect": (body, c) => withExpect(body, c.expect),
  "+micro-done": (body, c) => withMicroDone(body, c.expect),
  "+will-type": (body, c) => withWillType(body, c.space),
  "+all": (body, c) => withWillType(withMicroDone(withExpect(body, c.expect), c.expect), c.space),
  "+done-split": (body) => withDoneSplit(body),
  "+no-tree": (body) => withNoTree(body)
};
const SPLITS = new Set(["+done-split"]);

// ---- cases: 8 hard multilingual fixtures (snapshot-shaped actions) -----------

const A = (i, role, label, kind, ctx, extra = {}) => ({
  id: `e${i}`, node: i, role, label, kind, value: "", ctx: ctx || null,
  path: ctx ? ctx.split(" > ") : undefined, ...extra
});

const pageOf = (name, text) => ({
  url: `https://example.com/${name}`, title: name,
  text, headings: [], scroll: { y: 0, height: 900 }
});

  const WIKI_ACTIONS = (() => {
    const out = []; let i = 1;
    for (let n = 1; n <= 20; n++) out.push(A(i++, "link", `Nav topic ${String(n).padStart(2, "0")}`, "click", "Navigation"));
    for (let s = 1; s <= 20; s++) {
      const ctx = `Main > Section ${s}`;
      out.push(A(i++, "link", `Edit section ${s}`, "click", ctx));
      out.push(A(i++, "link", `Cite section ${s}`, "click", ctx));
      out.push(A(i++, "link", `See also ${s}`, "click", ctx));
    }
    for (let r = 1; r <= 40; r++) {
      const ctx = "Main > References";
      out.push(A(i++, "link", `Reference ${String(r).padStart(2, "0")}: some source title`, "click", ctx));
      out.push(A(i++, "button", "Edit ref", "click", ctx));
    }
    for (let b = 1; b <= 20; b++) out.push(A(i++, "link", `Infobox field ${b}`, "click", "Main > Infobox"));
    for (let f = 1; f <= 10; f++) out.push(A(i++, "link", `Footer link ${f}`, "click", "Footer"));
    return out;
  })();

const CASES = [
  { name: "1-vn-checkout", page: pageOf("cart", "Giỏ hàng của bạn có 2 sản phẩm. Tổng cộng 1.250.000₫."),
    actions: [
      A(1, "button", "Áp dụng mã giảm giá", "click", "Main > Giỏ hàng"),
      A(2, "button", "Thanh toán", "click", "Main > Giỏ hàng"),
      A(3, "button", "Đặt hàng", "click", "Main > Giỏ hàng"),
      A(4, "button", "Đặt hàng lại từ lần trước", "click", "Main > Giỏ hàng")
    ],
    goal: "Hoàn tất đơn hàng hiện tại ngay bây giờ",
    expectOperation: "CLICK", expectTarget: "e3" },

  { name: "2-jp-settings", page: pageOf("settings", "アカウント設定。変更内容はまだ保存されていません。"),
    actions: [
      A(1, "button", "保存", "click", "Main > 設定"),
      A(2, "button", "キャンセル", "click", "Main > 設定"),
      A(3, "button", "アカウント削除", "click", "Main > 設定"),
      A(4, "button", "保存して閉じる", "click", "Main > 設定")
    ],
    goal: "設定内容を確定して保存する（画面は閉じない）",
    expectOperation: "CLICK", expectTarget: "e1" },

  { name: "3-vn-en-fields", page: pageOf("profile", "Thông tin liên hệ / Contact details"),
    actions: [
      A(1, "textbox", "Email cá nhân", "fill", "Main > Liên hệ"),
      A(2, "textbox", "Email công việc", "fill", "Main > Liên hệ"),
      A(3, "textbox", "Ghi chú thêm", "fill", "Main > Liên hệ"),
      A(4, "button", "Gửi biểu mẫu", "click", "Main > Liên hệ")
    ],
    goal: "điền email cá nhân nguyen.a@example.com vào form (chưa cần bấm gửi)",
    fields: { "Email cá nhân": "nguyen.a@example.com", "Email công việc": "nguyen.a@congty.vn" },
    expectOperation: "TYPE_TEXT", expectTarget: "e1" },

  { name: "4-nested-org", page: pageOf("security", "Cài đặt bảo mật cho cá nhân và tổ chức."),
    actions: [
      A(1, "button", "Đổi mật khẩu", "click", "Cá nhân > Bảo mật"),
      A(2, "button", "Đổi mật khẩu", "click", "Tổ chức > Bảo mật"),
      A(3, "button", "Xem nhật ký", "click", "Cá nhân > Bảo mật"),
      A(4, "button", "Xem nhật ký", "click", "Tổ chức > Bảo mật")
    ],
    goal: "mở trang đổi mật khẩu cho TÀI KHOẢN CÁ NHÂN của tôi, không phải của tổ chức",
    expectOperation: "CLICK", expectTarget: "e1" },

  { name: "5-expect-wait", page: pageOf("processing", "Đang xử lý đơn hàng... Vui lòng không đóng trang."),
    actions: [
      A(1, "button", "Hủy bỏ", "click", "Main > Xử lý"),
      { id: "wait", kind: "wait", label: "Wait for the page to update", value: "" }
    ],
    goal: "chờ đến khi trang hiện thông báo Thành công rồi mới kết thúc",
    expect: { text: ["Thành công"] },
    expectOperation: "WAIT" },

  { name: "6-micro-finish", page: pageOf("form", "Biểu mẫu phản hồi. Bước cuối cùng."),
    actions: [
      A(1, "textbox", "Ghi chú", "fill", "Main > Phản hồi"),
      A(2, "button", "Gửi", "click", "Main > Phản hồi")
    ],
    goal: "điền ghi chú rồi bấm Gửi để hoàn thành",
    fields: { "Ghi chú": "Đã kiểm tra xong" },
    expect: { text: ["Cảm ơn"] },
    expectOperation: "TYPE_TEXT", expectTarget: "e1",
    planChecks: { step_2: "e2", step_3: "DONE" } },

  { name: "7-bilingual-table", page: pageOf("orders", "Danh sách đơn hàng / Order list — 15 đơn."),
    actions: (() => {
      const out = []; let i = 1;
      for (let r = 1; r <= 15; r++) {
        const ctx = `Đơn hàng > ORD-${String(r).padStart(4, "0")}`;
        out.push(A(i++, "button", "Xem chi tiết", "click", ctx));
        out.push(A(i++, "button", "Hủy đơn", "click", ctx));
        out.push(A(i++, "button", "In hóa đơn", "click", ctx));
      }
      return out;
    })(),
    goal: "hủy đơn hàng ORD-0007 (cancel order ORD-0007)",
    expectOperation: "CLICK", expectTarget: "e20" },

  { name: "8-premature-stop", page: pageOf("checkout", "Bước 2 trên 3: Xác nhận địa chỉ giao hàng."),
    actions: [
      A(1, "button", "Tiếp tục", "click", "Main > Thanh toán"),
      A(2, "button", "Hoàn tất", "click", "Main > Thanh toán"),
      A(3, "button", "Quay lại", "click", "Main > Thanh toán")
    ],
    goal: "hoàn tất toàn bộ quy trình mua hàng (tất cả các bước, đến trang cảm ơn)",
    expect: { text: ["Cảm ơn bạn đã mua hàng"] },
    expectOperation: "CLICK", expectTarget: "e1" },

  // Full-page dense fixture (wiki shape): nav + deep sections + references
  // cycle table + long text — the payload shape after dropping viewport cuts.
  { name: "wiki-full", onlyVariants: ["baseline", "+no-tree"], page: {
      url: "https://example.com/wiki/X", title: "X — Wikipedia",
      text: Array.from({ length: 20 }, (_, i) =>
        `Section ${i + 1}. Bài viết này mô tả chi tiết chủ đề thứ ${i + 1} với nhiều đoạn văn `
        + `dài phục vụ đo token toàn trang. `.repeat(3)).join("\n"),
      headings: Array.from({ length: 10 }, (_, i) => `Section ${i + 1}`),
      scroll: { y: 0, height: 9000 }
    },
    actions: WIKI_ACTIONS,
    goal: "open the citation link of Section 14",
    expectOperation: "CLICK", expectTarget: "e61" },

  // Same full page, disambiguation stress: 40 identical "Edit ref" buttons —
  // only the cycle rows in the tree say which row is which.
  { name: "wiki-full-cycle", onlyVariants: ["baseline", "+no-tree"], page: pageOf("wiki2", "References"),
    actions: WIKI_ACTIONS,
    goal: "press Edit on reference 23",
    expectOperation: "CLICK", expectTarget: "e126" },

  // The reverse gate: the page ALREADY satisfies the goal — the correct answer
  // is DONE. A tempting follow-up action ("Xem đơn hàng") baits a false continue.
  { name: "9-should-done", page: pageOf("done", "Thành công! Đơn hàng #12345 đã được đặt."),
    actions: [
      A(1, "link", "Xem đơn hàng vừa đặt", "click", "Main > Kết quả"),
      { id: "wait", kind: "wait", label: "Wait for the page to update", value: "" }
    ],
    goal: "dừng lại khi trang hiển thị thông báo Thành công",
    expect: { text: ["Thành công"] },
    expectOperation: "DONE" }
];

// ---- offline unit tests -------------------------------------------------------

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const buildFor = (c) => {
  const space = buildActionSpace(c.actions, c.fields || null);
  const body = buildQuestions({ ...c.page, actions: c.actions }, c.goal, [], space);
  return { space, body };
};

console.log("variant transform contracts...");

test("withExpect rewrites ONLY the DONE criterion, expect text included", () => {
  const c = CASES.find((x) => x.name === "5-expect-wait");
  const { body } = buildFor(c);
  const out = withExpect(body, c.expect);
  assert.match(out.questions.operation.criteria.DONE, /Thành công/);
  assert.equal(Object.keys(out.questions.operation.criteria).length,
    Object.keys(body.questions.operation.criteria).length);
  assert.equal(out.questions.operation.criteria.BLOCKED, body.questions.operation.criteria.BLOCKED);
  assert.equal(out.state.page.tree, body.state.page.tree);
});

test("withMicroDone adds DONE to step_2/step_3, leaves targets intact", () => {
  const c = CASES.find((x) => x.name === "6-micro-finish");
  const { body } = buildFor(c);
  const out = withMicroDone(body, c.expect);
  for (const key of ["step_2", "step_3"]) {
    assert.ok(out.questions[key].criteria.DONE, `${key} lacks DONE`);
    assert.ok(out.questions[key].criteria.SKIP, `${key} lost SKIP`);
  }
  assert.deepEqual(Object.keys(out.questions.click_target.criteria),
    Object.keys(body.questions.click_target.criteria));
});

test("withWillType annotates TYPE_TEXT entries only, keeps ids", () => {
  const c = CASES.find((x) => x.name === "3-vn-en-fields");
  const { space, body } = buildFor(c);
  const out = withWillType(body, space);
  assert.match(out.questions.type_text_target.criteria.e1.element, /will type: "nguyen\.a@example\.com"/);
  assert.equal(out.questions.type_text_target.criteria.e1.element,
    body.questions.type_text_target.criteria.e1.element + ' — will type: "nguyen.a@example.com"');
  assert.deepEqual(Object.keys(out.questions.click_target.criteria),
    Object.keys(body.questions.click_target.criteria));
});

test("withNoTree drops only the tree field — questions and page facts intact", () => {
  const c = CASES.find((x) => x.name === "wiki-full");
  const { body } = buildFor(c);
  assert.ok(body.state.page.tree && body.state.page.tree.length > 100, "fixture carries a tree");
  const out = withNoTree(body);
  assert.ok(!("tree" in out.state.page), "tree still present");
  assert.equal(out.state.page.url, body.state.page.url);
  assert.equal(out.state.page.text, body.state.page.text);
  assert.deepEqual(Object.keys(out.questions), Object.keys(body.questions));
});

test("withDoneSplit moves DONE into a binary gate, operation keeps the rest", () => {
  const c = CASES.find((x) => x.name === "9-should-done");
  const { body } = buildFor(c);
  const out = withDoneSplit(body);
  assert.deepEqual(Object.keys(out.questions.done_check.criteria).sort(), ["CONTINUE", "DONE"]);
  assert.ok(!("DONE" in out.questions.operation.criteria), "operation still owns DONE");
  assert.ok("BLOCKED" in out.questions.operation.criteria, "operation lost BLOCKED");
});

// Ids may MOVE between questions (done-split relocates DONE) but never vanish.
const unionOf = (questions) => {
  const ids = new Set();
  for (const q of Object.values(questions)) for (const id of Object.keys(q.criteria)) ids.add(id);
  return ids;
};

test("every variant preserves all offered ids and multilingual labels", () => {
  for (const c of CASES) {
    const { space, body } = buildFor(c);
    const baseIds = unionOf(body.questions);
    for (const [name, apply] of Object.entries(VARIANTS)) {
      const out = apply(body, { ...c, space });
      const outIds = unionOf(out.questions);
      for (const id of baseIds) {
        assert.ok(outIds.has(id), `${name}/${c.name}: id ${id} dropped`);
      }
      assert.ok(!out.state.page.tree || out.state.page.tree.includes("保存") || !c.name.includes("jp"),
        `${name}: jp label mangled`);
    }
  }
});

// ---- real-Jev benchmark (JEV_BENCH=1) -----------------------------------------

if (process.env.JEV_BENCH === "1") {
  console.log("\nreal-Jev variant benchmark (8 cases × 5 variants)...");
  const rows = [];
  for (const c of CASES) {
    const { space, body } = buildFor(c);
    for (const [name, apply] of Object.entries(VARIANTS)) {
      if (c.onlyVariants && !c.onlyVariants.includes(name)) continue;
      const payload = apply(body, { ...c, space });
      const started = Date.now();
      try {
        const result = await decide(payload, { preset: process.env.JEV_PRESET || "openrouter" });
        const operation = validateChoice(result.answers.operation || {},
          Object.keys(payload.questions.operation.criteria));
        assert.ok(operation, `${c.name}/${name}: operation failed validation`);
        let ok;
        let note = operation.choice;
        if (SPLITS.has(name)) {
          const gate = validateChoice(result.answers.done_check || {}, ["DONE", "CONTINUE"]);
          assert.ok(gate, `${c.name}/${name}: done_check failed validation`);
          if (c.expectOperation === "DONE") {
            ok = gate.choice === "DONE";
            note = `gate=${gate.choice}`;
          } else {
            ok = gate.choice === "CONTINUE" && operation.choice === c.expectOperation;
            note = `gate=${gate.choice} op=${operation.choice}`;
          }
        } else {
          ok = operation.choice === c.expectOperation;
        }
        if (ok && c.expectTarget) {
          const qKey = `${c.expectOperation.toLowerCase()}_target`;
          const target = validateChoice(result.answers[qKey] || {},
            Object.keys(payload.questions[qKey].criteria));
          ok = !!target && target.choice === c.expectTarget;
        }
        const tokens = result.usage?.prompt_tokens ?? result.usage?.input_tokens
          ?? result.usage?.promptTokens ?? "?";
        const notes = [];
        if (c.planChecks && name !== "baseline" && name !== "+expect") {
          for (const [step, want] of Object.entries(c.planChecks)) {
            const q = payload.questions[step];
            const answer = q && validateChoice(result.answers[step] || {}, Object.keys(q.criteria));
            notes.push(`${step}=${answer?.choice === want ? "✓" : (answer?.choice || "none")}`);
          }
        }
        rows.push({ case: c.name, variant: name, ok, tokens, ms: Date.now() - started });
        console.log(`  ${c.name.padEnd(19)} ${name.padEnd(11)} ${String(tokens).padStart(6)} tok ` +
          `${String(Date.now() - started).padStart(5)} ms  ${ok ? "✓" : `✗ ${note}`}` +
          (notes.length ? `  [${notes.join(", ")}]` : ""));
      } catch (e) {
        rows.push({ case: c.name, variant: name, ok: false, tokens: 0, ms: Date.now() - started });
        console.log(`  ${c.name.padEnd(19)} ${name.padEnd(11)} ERROR ${e.message.slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log("\nvariant totals (accuracy first, then tokens):");
  const summary = Object.keys(VARIANTS).map((name) => {
    const mine = rows.filter((r) => r.variant === name);
    return {
      name,
      ok: mine.filter((r) => r.ok).length,
      tokens: mine.reduce((a, r) => a + (typeof r.tokens === "number" ? r.tokens : 0), 0)
    };
  }).sort((a, b) => (b.ok - a.ok) || (a.tokens - b.tokens));
  for (const s of summary) {
    console.log(`  ${s.ok}/${CASES.length} correct  ~${s.tokens.toLocaleString()} tok  ${s.name}`);
  }
  console.log(`\nwinner: ${summary[0].name}`);
} else {
  console.log("\n(real-Jev variant benchmark skipped — run with JEV_BENCH=1)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
