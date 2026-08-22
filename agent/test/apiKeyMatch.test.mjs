// The two tunnel-facing HTTP routes (/api/local-sites, /api/proxy/start|end)
// gate on the presented key alone. verifyApiKeyCrc only ever checked the SHAPE
// of a v2 key, so any string matching the pattern authenticated — these cover
// the replacement, which compares against the key this agent actually holds.
//
// What this can and cannot do is worth stating: clients present the HEAD, which
// the design treats as public routing data. Matching it stops a stranger, not a
// device that once held the key and was revoked. Proving the TAIL over HTTP
// would mean putting it in a header, which is the thing the split exists to
// avoid — so the honest gate here is "the head of THIS key", and nothing more.
// Run: node --test agent/test/apiKeyMatch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesLocalKey } from "../cli/utils/apiKey.js";

const KEY_V2 = "sk-abcd1234-qrstuvwx-mnpqrstu";
const HEAD_V2 = "sk-abcd1234-qrstuvwx";
const KEY_V1 = "sk-abcd1234-qrst-a1b2c3";

test("the head of the stored key is accepted", () => {
  // What every real client sends: useAuth stores headOf(key), never the tail.
  assert.equal(matchesLocalKey(HEAD_V2, KEY_V2), true);
});

test("the full stored key is accepted", () => {
  // A pasted key or an older client that kept the whole thing.
  assert.equal(matchesLocalKey(KEY_V2, KEY_V2), true);
});

test("a well-formed key that is not ours is refused", () => {
  // The old check passed this: it matches the v2 pattern exactly.
  assert.equal(matchesLocalKey("sk-aaaaaaaa-aaaaaaaa-aaaaaaaa", KEY_V2), false);
  assert.equal(matchesLocalKey("sk-aaaaaaaa-aaaaaaaa", KEY_V2), false);
});

test("the right tail on the wrong head is refused", () => {
  assert.equal(matchesLocalKey("sk-zzzzzzzz-qrstuvwx-mnpqrstu", KEY_V2), false);
});

test("a v1 key matches itself and nothing else", () => {
  assert.equal(matchesLocalKey(KEY_V1, KEY_V1), true);
  assert.equal(matchesLocalKey("sk-abcd1234-qrst-ffffff", KEY_V1), false);
});

test("a v2 key does not open a v1 agent, or the reverse", () => {
  assert.equal(matchesLocalKey(KEY_V2, KEY_V1), false);
  assert.equal(matchesLocalKey(KEY_V1, KEY_V2), false);
});

test("nothing matches when the agent has no key", () => {
  // Fail closed: an agent that has not been set up yet admits no one.
  assert.equal(matchesLocalKey(HEAD_V2, null), false);
  assert.equal(matchesLocalKey(HEAD_V2, ""), false);
  assert.equal(matchesLocalKey(HEAD_V2, undefined), false);
});

test("empty and non-string presentations are refused", () => {
  assert.equal(matchesLocalKey("", KEY_V2), false);
  assert.equal(matchesLocalKey(null, KEY_V2), false);
  assert.equal(matchesLocalKey(undefined, KEY_V2), false);
  assert.equal(matchesLocalKey({}, KEY_V2), false);
  assert.equal(matchesLocalKey(HEAD_V2 + "\0", KEY_V2), false);
});

test("a prefix of the key does not match it", () => {
  // timingSafeEqual throws on a length mismatch; the guard must come first.
  assert.equal(matchesLocalKey("sk-abcd1234", KEY_V2), false);
  assert.equal(matchesLocalKey(HEAD_V2 + "x", KEY_V2), false);
});
