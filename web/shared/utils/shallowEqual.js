"use client";

// The agent re-sends whole lists and maps that are usually identical to what we
// already hold. Handing React a fresh object anyway changes the identity it
// compares on, so an unchanged payload re-renders every tab, the sidebar, the
// status bar and the bell — and leaves the old one behind as garbage for the GC
// to collect mid-frame. Comparing first is cheaper than either.

/** Same own enumerable keys, each strictly equal. Flat objects only. */
export function sameEntry(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  // `key in b` as well as the value: an explicit undefined and a missing key both read
  // as undefined, so comparing values alone would call {a: undefined} and {b: undefined}
  // equal while their shapes differ.
  for (const key of keysA) if (!(key in b) || a[key] !== b[key]) return false;
  return true;
}

/** Same length, same order, each element sameEntry. */
export function sameList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameEntry(a[i], b[i])) return false;
  return true;
}

/** Same keys, each value sameEntry. Keyed by session/workspace id. */
export function sameMap(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) if (!(key in b) || !sameEntry(a[key], b[key])) return false;
  return true;
}
