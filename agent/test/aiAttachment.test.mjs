// A chat attachment has to reach the CLI in the shape it understands: an image as a
// base64 content block, any other file as a path it can read. Both were verified
// against the real CLI — a 2x2 red PNG sent as a block comes back as "red".
// Run: node agent/test/aiAttachment.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

const { stageAttachment, buildAttachedMessage } = await import("../features/terminal/aiAttachment.js");
const { UPLOAD_DIR } = await import("../features/terminal/ptyHelper.js");

console.log("Running AI attachment tests...");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAf0kxAAAAABJRU5ErkJggg==";

test("an image becomes a base64 content block", () => {
  const staged = stageAttachment({ filename: "shot.png", type: "image/png", content: PNG_B64 });
  assert.equal(staged.kind, "image");
  assert.equal(staged.mediaType, "image/png");
  assert.equal(staged.data, PNG_B64);
});

test("any other file is written to disk and handed over as a path", () => {
  const staged = stageAttachment({ filename: "notes.txt", type: "text/plain", content: Buffer.from("hi").toString("base64") });
  assert.equal(staged.kind, "file");
  assert.ok(fs.existsSync(staged.path), "file must exist on disk for the CLI to read");
  assert.equal(fs.readFileSync(staged.path, "utf8"), "hi");
  assert.ok(path.dirname(staged.path) === UPLOAD_DIR);
  fs.rmSync(staged.path, { force: true });
});

test("a filename cannot steer the write path", () => {
  for (const evil of ["../../../etc/evil.sh", "/etc/passwd", "..", "a/b/c"]) {
    const staged = stageAttachment({ filename: evil, type: "text/plain", content: "" });
    // The separators are stripped, so the name is a flat entry in the upload dir —
    // the timestamp prefix means even a bare ".." cannot climb out.
    assert.equal(path.dirname(staged.path), UPLOAD_DIR, `escaped the upload dir via ${evil}`);
    assert.equal(path.basename(staged.path).includes("/"), false);
    fs.rmSync(staged.path, { force: true });
  }
});

test("the message puts images first and file paths into the text", () => {
  const img = stageAttachment({ filename: "a.png", type: "image/png", content: PNG_B64 });
  const doc = stageAttachment({ filename: "b.txt", type: "text/plain", content: "" });
  const msg = buildAttachedMessage("look at these", [doc, img]);

  assert.equal(msg.type, "user");
  const content = msg.message.content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.media_type, "image/png");
  assert.equal(content[1].type, "text");
  assert.ok(content[1].text.includes(doc.path), "the file path must reach the CLI");
  assert.ok(content[1].text.endsWith("look at these"));
  fs.rmSync(doc.path, { force: true });
});

test("an image with no caption still produces a message", () => {
  const img = stageAttachment({ filename: "a.png", type: "image/png", content: PNG_B64 });
  const msg = buildAttachedMessage("", [img]);
  assert.equal(msg.message.content.length, 2);
  assert.equal(msg.message.content[1].text, "");
});

test("no staged files yields null so the caller keeps the plain text shape", () => {
  assert.equal(buildAttachedMessage("hello", null), null);
  assert.equal(buildAttachedMessage("hello", []), null);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
