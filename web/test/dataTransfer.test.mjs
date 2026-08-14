// Characterization tests for the drop/paste → upload-items converter extracted
// from FileExplorer, plus the SSR-safety contract of sitesStorage.
// A folder drop must preserve its relative paths or the upload flattens the tree
// on the host; an SSR read must not throw during Next's server render.
// Run: node --import ./test/loader-alias.mjs web/test/dataTransfer.test.mjs
import assert from "node:assert/strict";
import { dataTransferToItems, traverseEntry, readAllEntries } from "../features/fileExplorer/lib/dataTransfer.js";
import { getCustomPorts, saveCustomPorts, getSiteLabels, saveSiteLabels } from "../features/terminal/lib/sitesStorage.js";

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push(Promise.resolve().then(async () => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}));

// ── Fake FileSystem entries (what webkitGetAsEntry returns) ───────────────────
const fileEntry = (name) => ({
  isFile: true, isDirectory: false, name,
  file: (res) => res({ name })
});
const dirEntry = (name, children, { batchSize = 100 } = {}) => ({
  isFile: false, isDirectory: true, name,
  createReader() {
    let i = 0;
    return {
      // The real API returns children in batches and signals the end with an
      // empty batch — readAllEntries must keep calling until then.
      readEntries(cb) {
        const batch = children.slice(i, i + batchSize);
        i += batch.length;
        cb(batch);
      }
    };
  }
});

test("flat file drop keeps the bare name as its relative path", async () => {
  const items = await dataTransferToItems({ items: [{ webkitGetAsEntry: () => fileEntry("a.txt") }] });
  assert.deepEqual(items, [{ file: { name: "a.txt" }, relativePath: "a.txt" }]);
});

test("folder drop preserves the nested relative paths", async () => {
  const tree = dirEntry("src", [
    fileEntry("index.js"),
    dirEntry("lib", [fileEntry("util.js")])
  ]);
  const items = await dataTransferToItems({ items: [{ webkitGetAsEntry: () => tree }] });
  assert.deepEqual(items.map((i) => i.relativePath), ["src/index.js", "src/lib/util.js"]);
});

test("readAllEntries drains every batch, not just the first", async () => {
  const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.txt`));
  const out = await readAllEntries(dirEntry("big", children, { batchSize: 100 }).createReader());
  assert.equal(out.length, 250, "a single readEntries call would only return 100");
});

test("a failing reader resolves with what it has (never hangs the upload)", async () => {
  const reader = { readEntries: (_ok, err) => err(new Error("nope")) };
  assert.deepEqual(await readAllEntries(reader), []);
});

test("clipboard paste falls back to the flat files list", async () => {
  // Pasted content exposes no entries — only `files`.
  const items = await dataTransferToItems({ items: [], files: [{ name: "shot.png" }] });
  assert.deepEqual(items, [{ file: { name: "shot.png" }, relativePath: "shot.png" }]);
});

test("entries win over files when both are present (folders must survive)", async () => {
  const items = await dataTransferToItems({
    items: [{ webkitGetAsEntry: () => dirEntry("d", [fileEntry("x")]) }],
    files: [{ name: "ignored.txt" }]
  });
  assert.deepEqual(items.map((i) => i.relativePath), ["d/x"]);
});

test("an empty or malformed DataTransfer yields no items", async () => {
  assert.deepEqual(await dataTransferToItems({}), []);
  assert.deepEqual(await dataTransferToItems({ items: [{}], files: [] }), []);
});

test("traverseEntry appends into the caller's array with a prefix", async () => {
  const out = [];
  await traverseEntry(fileEntry("a.txt"), "base", out);
  assert.deepEqual(out, [{ file: { name: "a.txt" }, relativePath: "base/a.txt" }]);
});

// ── sitesStorage SSR contract (no `window` in node — same as Next's server render)
test("sitesStorage reads return defaults without a window", () => {
  assert.deepEqual(getCustomPorts(), []);
  assert.deepEqual(getSiteLabels(), {});
});

test("sitesStorage writes are silent no-ops without a window", () => {
  saveCustomPorts([3000]);
  saveSiteLabels({ 3000: "dev" });
});

await Promise.all(tests);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
