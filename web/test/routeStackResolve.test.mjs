import assert from "node:assert/strict";
import { test } from "node:test";
import { stackForUrl, viewToPath, pathToView } from "../features/terminal/constants/routeConfig.js";

const list = { type: "list" };
const termA = { type: "terminal", sessionId: "a" };
const termB = { type: "terminal", sessionId: "b" };
const files = { type: "files", workspace: "/w" };

test("Back out of files cuts to the terminal already in the stack", () => {
  const stack = [list, termB, files];
  assert.deepEqual(stackForUrl(stack, termB), [list, termB]);
});

test("Back out of files with two terminals open keeps the one below, not a copy", () => {
  const stack = [list, termA, termB, files];
  assert.deepEqual(stackForUrl(stack, termA), [list, termA]);
});

test("Back to list collapses the whole stack", () => {
  const stack = [list, termB, files];
  assert.deepEqual(stackForUrl(stack, list), [list]);
});

test("Switching tabs replaces the top instead of growing the stack", () => {
  const stack = [list, termA];
  assert.deepEqual(stackForUrl(stack, termB), [list, termB]);
});

test("A view the stack does not hold is a new level", () => {
  assert.equal(stackForUrl([list, termB], files), null);
});

test("Pair view round-trips through the URL", () => {
  const pair = { type: "pair" };
  assert.equal(viewToPath(pair), "/workspace/pair");
  assert.deepEqual(pathToView("/workspace/pair", new URLSearchParams()), pair);
});
