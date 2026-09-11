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

test("returns null when there is nothing to parse", () => {
  assert.equal(parseAnswered(""), null);
  assert.equal(parseAnswered("no pairs here"), null);
  assert.equal(parseAnswered(undefined), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
