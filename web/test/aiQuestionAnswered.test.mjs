// Run: node web/test/aiQuestionAnswered.test.mjs
import assert from "node:assert/strict";
import { parseAnswered } from "../features/ai/lib/parseAnswered.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log("Running AskUserQuestion answered-parser tests...");

test("parses the CLI's answered-questions summary", () => {
  const out = parseAnswered('User has answered your questions: "Which library?"="React", "Scope?"="minimal". You can now continue.');
  assert.deepEqual(out, { "Which library?": "React", "Scope?": "minimal" });
});

test("unescapes quotes inside answers", () => {
  assert.deepEqual(parseAnswered('"Q"="say \\"hi\\" now"'), { Q: 'say "hi" now' });
  assert.deepEqual(parseAnswered('"Câu hỏi"="Có"'), { "Câu hỏi": "Có" });
});

test("tolerates whitespace around the equals sign", () => {
  assert.deepEqual(parseAnswered('"A" = "1"'), { A: "1" });
});

// The host writes the question back verbatim and does NOT escape quotes inside it, so
// the key the regex sees is the tail after the last inner quote. Measured: 20 of 107
// real answers look like this, and each one drew "Answered" with nothing under it.
test("a question containing quotes still matches its answer", () => {
  const q = '"Nhớ tab hiện tại theo workspace" là nhớ tab nào?';
  const out = parseAnswered(`Your questions have been answered: "${q}"="Cả hai". You can now continue.`, [q]);
  assert.deepEqual(out, { [q]: "Cả hai" });
});

test("two quoted questions keep their own answers, in order", () => {
  const a = 'Bạn muốn "tạo agent" nghĩa là gì?';
  const b = 'Nút copy "thông minh hơn" theo kiểu nào?';
  const text = `Your questions have been answered: "${a}"="Ý 1", "${b}"="Ý 2".`;
  assert.deepEqual(parseAnswered(text, [a, b]), { [a]: "Ý 1", [b]: "Ý 2" });
});

test("no questions given falls back to the raw pairs", () => {
  assert.deepEqual(parseAnswered('"A"="1", "B"="2"'), { A: "1", B: "2" });
});

test("returns null when there is nothing to parse", () => {
  assert.equal(parseAnswered(""), null);
  assert.equal(parseAnswered("no pairs here"), null);
  assert.equal(parseAnswered(undefined), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
