// Deciding whether a live event is one this client has already applied. Pure, so the
// rule can be pinned without mounting the hook — the wiring around it needs a browser.

// `appliedSeq` is the highest host seq already in the store: the snapshot a hydrate
// replayed, or the newest live event since. Anything at or below it is a duplicate.
//
// A watermark of 0 means nothing has been applied yet, so NOTHING is a duplicate. A
// hydrate that answered with no log leaves it there, and a live event after that is the
// turn's only copy.
//
// Unstamped events (`seq == null`, an older agent) pass: there is nothing to compare, and
// dropping them would lose real turns to be safe about replayed ones.
export function isAlreadyApplied(seq, appliedSeq) {
  if (seq == null) return false;
  return seq <= (appliedSeq || 0);
}
