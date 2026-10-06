import test from "node:test";
import assert from "node:assert/strict";
import { grepContent } from "../features/browserUse/grep.js";

const PAGE = [
  "# Shop danh mục",
  "Chuột Logitech MX giá 2.5tr",
  "Bàn phím cơ Akko",
  "Màn hình LG 27inch",
  "Tổng tiền: 3.750.000đ",
  "Giao hàng miễn phí",
  "Xem thêm [Chính sách đổi trả](https://shop.com/policy)",
  "Liên hệ [Hỗ trợ](https://shop.com/help) ngay",
  "Chuột không dây khác"
].join("\n");

test("grepContent: basic filter, case-insensitive default", () => {
  const r = grepContent(PAGE, { pattern: "logitech" });
  assert.equal(r.matched, 1);
  assert.match(r.text, /Chuột Logitech MX/);
  assert.ok(!r.text.includes("Bàn phím"));
});

test("grepContent: case-sensitive flag", () => {
  const r = grepContent(PAGE, { pattern: "logitech", caseSensitive: true });
  assert.equal(r.matched, 0);
});

test("grepContent: context merges adjacent windows, separates disjoint ones", () => {
  // matches at lines 2 (Logitech) and 9 (Chuột khác) — windows [1..3] and [8..9], disjoint
  const r = grepContent(PAGE, { pattern: "chuột", context: 1 });
  const lines = r.text.split("\n");
  assert.ok(lines.includes("--"));
  assert.ok(r.text.includes("Bàn phím cơ Akko")); // context after match 1
  assert.ok(!lines.some((l) => l === "Giao hàng miễn phí")); // line 6 — outside both windows
});

test("grepContent: adjacent matches merge without separator", () => {
  const r = grepContent(PAGE, { pattern: "bàn phím", context: 2 });
  assert.ok(r.text.includes("Màn hình LG"));
  assert.ok(!r.text.includes("--"));
});

test("grepContent: lineNumbers use N: for match, N- for context", () => {
  const r = grepContent(PAGE, { pattern: "Tổng tiền", context: 1, lineNumbers: true });
  const lines = r.text.split("\n");
  assert.ok(lines.some((l) => l.startsWith("4- ")));  // context line 4
  assert.ok(lines.some((l) => l.startsWith("5: ")));  // match line 5
  assert.ok(lines.some((l) => l.startsWith("6- ")));  // context line 6
});

test("grepContent: invert returns non-matching lines, no context", () => {
  const r = grepContent(PAGE, { pattern: "Chuột|chuột", invert: true, lineNumbers: true });
  assert.ok(r.matched > 0);
  assert.ok(!r.text.includes("Logitech"));
  assert.ok(!r.text.includes("--"));
});

test("grepContent: max caps the match count", () => {
  const r = grepContent(PAGE, { pattern: "o", max: 3 });
  assert.equal(r.matched, 3);
});

test("grepContent: links mode extracts label -> url", () => {
  const r = grepContent(PAGE, { links: true });
  assert.equal(r.matched, 2);
  assert.ok(r.text.includes("Chính sách đổi trả -> https://shop.com/policy"));
  assert.ok(r.text.includes("Hỗ trợ -> https://shop.com/help"));
});

test("grepContent: links mode + pattern filters urls", () => {
  const r = grepContent(PAGE, { links: true, pattern: "help" });
  assert.equal(r.matched, 1);
  assert.ok(r.text.includes("https://shop.com/help"));
});

test("grepContent: head/tail post-filter output lines", () => {
  const all = grepContent(PAGE, { pattern: "" });
  const h = grepContent(PAGE, { pattern: "", head: 3 });
  assert.equal(h.text.split("\n").length, 3);
  const t = grepContent(PAGE, { pattern: "", tail: 2 });
  assert.equal(t.text.split("\n").length, 2);
  assert.ok(t.text.includes("Chuột không dây khác"));
});

test("grepContent: invalid regex falls back to substring match", () => {
  // "[đặc" is an unclosed character class — as a literal it IS in the text
  const r = grepContent("giá [đặc biệt] hôm nay", { pattern: "[đặc" });
  assert.equal(r.matched, 1);
  assert.ok(r.text.includes("giá [đặc biệt]"));
});

test("grepContent: no context means no -- separator between distant matches", () => {
  const r = grepContent(PAGE, { pattern: "Chuột" }); // matches lines 2 and 9
  assert.equal(r.matched, 2);
  assert.ok(!r.text.includes("--"), "grep(1) only separates when context is requested");
  assert.equal(r.text.split("\n").length, 2);
});

test("grepContent: no match returns empty text, matched 0", () => {
  const r = grepContent(PAGE, { pattern: "zzz-không-có" });
  assert.equal(r.matched, 0);
  assert.equal(r.text, "");
});

test("grepContent: invert + lineNumbers numbers the kept lines (grep -nv)", () => {
  const r = grepContent(PAGE, { pattern: "Chuột", invert: true, lineNumbers: true });
  // grep(1): `seq 3 | grep -nv 2` -> "1:1\n3:3" — numbers survive -v
  assert.ok(r.matched > 0);
  assert.ok(r.text.split("\n").every((l) => /^\d+:/.test(l)), `every -v line must carry N: — got:\n${r.text}`);
  assert.ok(!r.text.split("\n").some((l) => /^\d+-/.test(l)), "-v carries no context lines");
});
