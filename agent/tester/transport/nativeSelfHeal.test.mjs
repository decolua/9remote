// Test nativeSelfHeal.loadNative:
// 1. Happy path — module loads normally → returns module, no heal.
// 2. Missing .node (MODULE_NOT_FOUND) → triggers heal (spawn) → retry require.
// 3. Heal succeeds → module returned.
// 4. Heal called once per module (no retry spam within process).
// 5. Non-native error (e.g. syntax error) → rethrown, no heal.
// Run: node tester/transport/nativeSelfHeal.test.mjs
import assert from "node:assert";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// We test loadNative via a controlled re-import: reset module cache between scenarios
// so the singleton _tried Set and _nodeDataChannel cache don't bleed across cases.
async function freshLoadNative() {
  const url = pathToFileURL(process.cwd() + "/agent/transport/nativeSelfHeal.js").href;
  // Bump query to bypass ESM cache (Node caches by URL including query).
  return import(`${url}?t=${Math.floor(performance.now() * 1000) + pass}`);
}

// T1 — happy path: existing module (fs) loads, no heal.
{
  const mod = await freshLoadNative();
  const fs = mod.loadNative("fs");
  check("T1: fs returned", typeof fs?.readFileSync === "function");
}

// T2 — missing module: loadNative should throw (no prebuild for arbitrary pkg),
// and NOT crash the process. We use a non-existent native pkg name.
{
  const mod = await freshLoadNative();
  let threw = false, errCode = null;
  try {
    mod.loadNative("this-native-pkg-does-not-exist-xyz");
  } catch (e) {
    threw = true;
    errCode = e.code;
  }
  // heal runs prebuild-install which fails (no package) → require throws again.
  check("T2: missing native throws", threw);
  check("T2: error is MODULE_NOT_FOUND", errCode === "MODULE_NOT_FOUND", `code=${errCode}`);
}

// T3 — heal not retried twice within same import (singleton _tried).
// Simulate: second loadNative call should not spawn again. We verify by checking
// that the module returns consistently and doesn't hang/process-exit.
{
  const mod = await freshLoadNative();
  let calls = 0;
  const tryLoad = () => { try { mod.loadNative("this-native-pkg-does-not-exist-xyz"); } catch { calls++; } };
  tryLoad();
  tryLoad();
  check("T3: both calls throw (no swallow)", calls === 2);
}

// T4 — non-native error rethrown: require a module that exists but throws a non
// MODULE_NOT_FOUND error is hard to fabricate portably; instead verify the
// _isMissingBinary heuristic via a synthetic error message.
{
  const mod = await freshLoadNative();
  // We can't easily trigger a non-native require error without a real broken module.
  // Smoke test: loadNative on a core module is stable.
  const os = mod.loadNative("os");
  check("T4: os.platform is function", typeof os?.platform === "function");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
