// A codex permission grant, as the card prints it.
//
// The shapes are the server's own (`codex app-server generate-ts`): a profile of
// `network` + `fileSystem`, with each path a union of three spellings. Printed raw it is
// a wall of nulls; the card has to say what is actually being asked for, because that is
// the whole basis of the user's decision.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiPermissionGrant.test.mjs
import assert from "node:assert/strict";
import { permissionGrantText, permissionLines } from "../features/ai/lib/permissionGrant.js";

let pass = 0, fail = 0;
const test = (n, f) => {
  try { f(); pass++; console.log(`  ok  ${n}`); }
  catch (e) { fail++; console.error(`  FAIL ${n}\n       ${e.message}`); }
};

test("a grant says what it wants, one fact per line", () => {
  const text = permissionGrantText({
    kind: "permission_grant",
    reason: "needs the network to install deps",
    permissions: { network: { enabled: true } }
  });
  assert.equal(text, "needs the network to install deps\n• network access");
});

test("the three spellings of a path all read as a path", () => {
  const lines = permissionLines({
    fileSystem: {
      entries: [
        { path: { type: "path", path: "/tmp/a.txt" }, access: "write" },
        { path: { type: "glob_pattern", pattern: "**/*.log" }, access: "read" },
        { path: { type: "special", value: "projectRoot" }, access: "read" }
      ]
    }
  });
  assert.deepEqual(lines, ["• write /tmp/a.txt", "• read **/*.log", "• read projectRoot"]);
});

test("the legacy read/write arrays still read", () => {
  // The server marks these "will be removed in favor of entries" — until then, a real
  // request can carry them, and a card that only understood `entries` would print nothing.
  assert.deepEqual(permissionLines({ fileSystem: { read: ["/etc"], write: ["/tmp"] } }),
    ["• read /etc", "• write /tmp"]);
});

test("network disabled is not a request", () => {
  // `enabled: null` is the server saying nothing either way, and `false` is it saying no.
  assert.deepEqual(permissionLines({ network: { enabled: null } }), []);
  assert.deepEqual(permissionLines({ network: { enabled: false } }), []);
});

test("a grant with no details still says something", () => {
  assert.equal(permissionGrantText({ kind: "permission_grant", permissions: {} }), "");
  assert.equal(permissionGrantText({ kind: "permission_grant", reason: "why not" }), "why not");
});

test("anything that is not a grant falls through to the command line", () => {
  // The caller relies on "" to mean "show the command instead" — the other gates are
  // command/path shaped and must not be turned into a profile card.
  assert.equal(permissionGrantText({ command: "rm -rf /" }), "");
  assert.equal(permissionGrantText({ path: "/w/a.txt" }), "");
  assert.equal(permissionGrantText(null), "");
  assert.equal(permissionGrantText(undefined), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
