// The service worker relays each request to whichever client said "bridge-hello".
// Every browsed site shares this origin, so a dev server rendering untrusted
// content can send that message too — and then it receives every other tab's
// requests (URLs, headers, bodies) and answers them with whatever it likes.
//
// The shell is the only page allowed to be the bridge, and it is distinguishable
// by where it is served from: /proxy.html, never inside /browse/.
// Run: node --import ./test/loader-alias.mjs web/test/swBridgeClaim.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The worker loads this with importScripts: a classic script that defines a
// global, with no export of any kind. Evaluating the file is how the test gets
// at the same function the worker will run — and it fails loudly if the file
// ever stops being loadable that way.
const src = readFileSync(new URL("../public/swBridgeClaim.js", import.meta.url), "utf8");
const canBeBridge = new Function(`${src}; return canBeBridge;`)();
const appOriginsFor = new Function(`${src}; return appOriginsFor;`)();

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const ORIGIN = "https://sites.9remote.cc";

test("the proxy shell may be the bridge", () => {
  assert.equal(canBeBridge(`${ORIGIN}/proxy.html`, ORIGIN), true);
});

test("the shell with a cache-buster still may", () => {
  // BrowserView appends ?r=N to force a reload.
  assert.equal(canBeBridge(`${ORIGIN}/proxy.html?r=3`, ORIGIN), true);
  assert.equal(canBeBridge(`${ORIGIN}/proxy.html?r=3#port=3000`, ORIGIN), true);
});

test("a browsed site may not", () => {
  // The attack: a dev server claiming to be the bridge.
  assert.equal(canBeBridge(`${ORIGIN}/browse/3000/`, ORIGIN), false);
  assert.equal(canBeBridge(`${ORIGIN}/browse/3000/app.html`, ORIGIN), false);
});

test("a site cannot dress its path up as the shell", () => {
  for (const url of [
    `${ORIGIN}/browse/3000/proxy.html`,
    `${ORIGIN}/browse/3000/../proxy.html`,
    `${ORIGIN}/browse/3000/?x=/proxy.html`,
    `${ORIGIN}/browse/3000/#/proxy.html`,
    `${ORIGIN}/proxy.html/../browse/3000/`
  ]) {
    assert.equal(canBeBridge(url, ORIGIN), false, `accepted ${url}`);
  }
});

test("another origin may not, whatever its path", () => {
  // Belt to the origin check the SW cannot make on its own: clients.matchAll
  // only ever returns same-origin clients, but the message handler sees
  // event.source without that guarantee being restated.
  assert.equal(canBeBridge("https://evil.com/proxy.html", ORIGIN), false);
  assert.equal(canBeBridge("https://9remote.cc/proxy.html", ORIGIN), false);
  assert.equal(canBeBridge(`${ORIGIN}.evil.com/proxy.html`, ORIGIN), false);
});

test("a missing or malformed url is refused", () => {
  for (const url of [null, undefined, "", "not-a-url", 42, {}]) {
    assert.equal(canBeBridge(url, ORIGIN), false, `accepted ${JSON.stringify(url)}`);
  }
});

test("the root path is refused", () => {
  // The worker serves the shell at "/" too, but the shell itself always loads
  // /proxy.html — accepting "/" would widen the surface for nothing.
  assert.equal(canBeBridge(`${ORIGIN}/`, ORIGIN), false);
});

// ── frame-ancestors names every loopback spelling ───────────────────────────

test("the agent's shell is framable through any loopback name", () => {
  // The agent serves its workspace on localhost and 127.0.0.1 alike, and the
  // policy is checked against the ancestor actually used. Naming only one leaves
  // the site unframable for the other — which renders as a blank frame.
  const csp = appOriginsFor("sites.localhost", "2208");
  assert.equal(csp, "http://localhost:2208 http://127.0.0.1:2208");
  assert.ok(!csp.includes("*"), "wildcard in the ancestor list");
  // An IPv6 literal is not a valid source expression: Chrome rejects the whole
  // directive over it, which would leave the shell unframable everywhere.
  assert.ok(!csp.includes("[::1]"), "IPv6 literal in the ancestor list");
});

test("the port is kept for every named ancestor", () => {
  // A sites name without the port points at :80, where nothing is listening.
  assert.equal(appOriginsFor("sites.localhost", ""), "http://localhost http://127.0.0.1");
  assert.equal(appOriginsFor("sites.localhost", "3000"), "http://localhost:3000 http://127.0.0.1:3000");
});

test("the hosted deploys name one ancestor each, over https", () => {
  assert.equal(appOriginsFor("sites.9remote.cc", ""), "https://9remote.cc");
  assert.equal(appOriginsFor("sites-dev.9remote.cc", ""), "https://dev.9remote.cc");
  assert.equal(appOriginsFor("sites.9remote.cc", "443"), "https://9remote.cc:443");
});

test("an unknown host gets no ancestor at all", () => {
  // Then frame-ancestors is 'self' alone, and a load fails rather than any
  // origin being given the benefit of the doubt.
  assert.equal(appOriginsFor("sites.evil.tld", "2208"), "");
  assert.equal(appOriginsFor("", "2208"), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
