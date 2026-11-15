// Decisions for patching holes in the live ai:event stream — pure, so the rule is
// pinnable without a browser (same law as lib/seqDedupe). The hook owns timers/sends.
//
// `epoch` is the host's log generation, stamped on every event by a new host. A null
// epoch on either side means "old host" or "not yet known" — the new paths stand down
// and the pane keeps its pre-patch behavior.

/** What to do with one live event, given the client's watermark and generation.
 *  resync  — the event belongs to a NEWER log generation whose reset never arrived;
 *            the watermark is invalid, pull the whole log again.
 *  stale   — an event from a generation the client already replaced; drop.
 *  dup     — at/below the watermark: already applied.
 *  gap     — above watermark+1: a recorded event went missing; fetch the range.
 *  apply   — contiguous and current. */
export function classifyLiveEvent({ seq, epoch }, { appliedSeq, logEpoch }) {
  if (epoch != null && logEpoch == null) return "adopt"; // first stamped event seeds the generation
  if (epoch != null && logEpoch != null && epoch !== logEpoch) {
    return epoch > logEpoch ? "resync" : "stale";
  }
  if (seq == null) return "apply";
  if (seq <= appliedSeq) return "dup";
  // A hole is only knowable inside one stamped generation — an unstamped event (older
  // host) keeps the pre-patch behavior no matter how its seqs jump.
  if (epoch != null && epoch === logEpoch && seq > appliedSeq + 1) return "gap";
  return "apply";
}

/** Whether a fetched range is safe to apply on top of the watermark.
 *  Unsafe when it does not start exactly at watermark+1 (still gappy or the host
 *  shed records) or when a compacted stream record (_fromSeq ≤ watermark) overlaps
 *  text already applied — either way the caller resyncs whole instead. */
export function fetchedIsSafe(events, appliedSeq) {
  const fresh = events.filter((e) => e.seq != null && e.seq > appliedSeq);
  if (!fresh.length) return { safe: true, apply: [] };
  if (fresh[0].seq !== appliedSeq + 1) return { safe: false };
  const overlap = fresh.find((e) =>
    (e.event === "delta" || e.event === "thinking") && e._fromSeq != null && e._fromSeq <= appliedSeq);
  if (overlap) return { safe: false };
  return { safe: true, apply: fresh };
}

/** Split a queue of live events against the watermark: the contiguous prefix to
 *  apply now, the suffix held behind the first hole, and a resync signal when a
 *  newer log generation shows up. The one law shared by the hydrate release and
 *  the gap drain — a hole must never be walked over silently.
 *  Returns { apply, held, resync, appliedSeq, logEpoch }. */
export function splitByHole(items, { appliedSeq, logEpoch }) {
  const apply = [];
  const held = [];
  let seq = appliedSeq;
  let epoch = logEpoch;
  for (const item of items) {
    // Nothing slips past a hole — not an unstamped event, not a reset. Applying any of
    // them would land out of order, and a reset would erase the hole the fetch still needs.
    if (held.length) { held.push(item); continue; }
    // A reset restarts the log at seq 1 and clears the watermark with it.
    if (item.event === "conversation_reset") {
      apply.push(item);
      seq = 0;
      epoch = item.data?.epoch ?? (epoch ?? 0) + 1;
      continue;
    }
    const verdict = classifyLiveEvent(item, { appliedSeq: seq, logEpoch: epoch });
    if (verdict === "resync") return { apply, held: [], resync: true, appliedSeq: seq, logEpoch: epoch };
    if (verdict === "gap") { held.push(item); continue; }
    if (verdict === "adopt") epoch = item.epoch;
    if (verdict === "stale" || verdict === "dup") continue;
    apply.push(item);
    if (item.seq != null) seq = item.seq;
  }
  return { apply, held, resync: false, appliedSeq: seq, logEpoch: epoch };
}
