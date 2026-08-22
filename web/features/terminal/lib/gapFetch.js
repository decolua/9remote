import { GAP_FETCH_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";

// Seq-gap recovery (plan G): request just the missing live-output range [lastSeq+1 .. toSeq]
// and append it — no reset, no flash. Live output arriving meanwhile is queued in `pending`
// and flushed once the whole range lands, so order stays [gap … live]. Falls back to a full
// reset+rejoin on a ring miss or a stalled transfer.
//
// deps:
//   emit(payload, ack)  — socket.emit("requestGap", ...) ack callback
//   writeChunk(data)    — paint a gap chunk or a queued live chunk (order preserved)
//   flush()             — force-paint the write batcher once after a queued burst
//   onGapChunk(seq)     — called per painted gap chunk (caller advances lastSeq)
//   onFallback()        — full reset+rejoin (miss/timeout)
//   log(...)            — termLog
export function createGapFetch({ emit, writeChunk, flush, onGapChunk, onFallback, log, getFromSeq }) {
  let awaiting = null; // { pending, fromSeq, toSeq, settled, timer, expected, received, seen }
  const gapFetchFromSeq = () => getFromSeq();

  const isBusy = () => awaiting !== null;

  // (Re)arm the stall deadline — called on start and after every chunk that lands.
  const armTimer = (gapState) => {
    clearTimeout(gapState.timer);
    gapState.timer = setTimeout(() => fallback(gapState, "stalled"), GAP_FETCH_TIMEOUT_MS);
  };

  const finish = (gapState) => {
    // Cancelled (reconnect/unmount nulled the state) → the rejoin owns the buffer now;
    // painting here would land on content we no longer own.
    if (gapState.settled || awaiting !== gapState) return;
    gapState.settled = true;
    clearTimeout(gapState.timer);
    gapState.timer = null;
    for (const p of gapState.pending) {
      writeChunk(p.data);
      if (p.seq != null) onGapChunk(p.seq);
    }
    flush?.();
    awaiting = null;
    log(`gap recovered (${gapState.received}/${gapState.expected} chunks, ${gapState.pending.length} pending flushed)`);
  };

  const fallback = (gapState, why) => {
    // A reconnect may already have scheduled its own reset+rejoin — don't fire a second one on top.
    if (gapState.settled || awaiting !== gapState) return;
    gapState.settled = true;
    clearTimeout(gapState.timer);
    gapState.timer = null;
    awaiting = null;
    log(`gap ${why} (${gapState.fromSeq}..${gapState.toSeq}) → reset+rejoin`);
    onFallback();
  };

  /** toSeq: last missing seq (inclusive); pending: live chunks to flush after the gap */
  function start(toSeq, pending = []) {
    if (awaiting) return; // a fetch is already in flight
    const fromSeq = gapFetchFromSeq();
    if (toSeq < fromSeq) return; // nothing missing
    log(`seq gap (last=${fromSeq - 1} → ${toSeq + 1}) → requestGap ${fromSeq}..${toSeq}`);
    const gapState = {
      pending: [...pending],
      fromSeq, toSeq,
      settled: false, timer: null,
      expected: null,  // chunk count from the ack (null until it arrives)
      received: 0,
      seen: new Set(), // distinct gap seqs painted — dedups retransmits
    };
    awaiting = gapState;
    // Safety: ack never returns, or chunks stall in transit (carrier drop) → reset+rejoin
    // instead of queueing live output forever. The deadline measures SILENCE, not total
    // duration — a long gap streams many packets and must not be aborted mid-transfer.
    armTimer(gapState);
    emit({ fromSeq, toSeq }, (res) => {
      if (gapState.settled || awaiting !== gapState) return; // cancelled meanwhile
      if (!res?.hit) return fallback(gapState, "miss"); // evicted from the ring
      gapState.expected = res.count ?? 0;
      // The ack can beat its own chunks (different carrier), so only finish when every
      // chunk has landed; the timer covers the stalled case.
      if (gapState.received >= gapState.expected) finish(gapState);
    });
  }

  /** Queue live output while a fetch is in flight (flushed after the gap lands) */
  function queueLive(data, seq) {
    if (!awaiting) return false;
    awaiting.pending.push({ data, seq });
    return true;
  }

  /** Handle a gap chunk payload; true when consumed. Guards: fetch in flight + seq inside
   *  range + not a retransmit — a chunk after a miss/timeout fallback would corrupt the
   *  fresh buffer and rewind lastSeq → spurious gap loop. */
  function handleGapChunk(data, seq) {
    const gap = awaiting;
    if (!gap || seq == null) return false;
    if (seq < gap.fromSeq || seq > gap.toSeq) return false;
    if (gap.seen.has(seq)) return true; // retransmit — already painted
    armTimer(gap); // progress → push the stall deadline back
    writeChunk(data);
    onGapChunk(seq);
    // Count DISTINCT seqs: a duplicate delivery must not make the set look complete while a
    // real chunk is still missing.
    gap.seen.add(seq);
    gap.received = gap.seen.size;
    // The ack may arrive over a different carrier than the chunks, so it can land first.
    // Only finish once BOTH the ack and all its chunks are in, else the remaining chunks
    // would be rejected by the range guard above and their content lost silently.
    if (gap.expected != null && gap.received >= gap.expected) finish(gap);
    return true;
  }

  /** Cancel an in-flight fetch (reconnect/unmount) — suppresses its fallback timer */
  function cancel() {
    if (!awaiting) return;
    clearTimeout(awaiting.timer);
    awaiting = null;
  }

  return { start, queueLive, handleGapChunk, cancel, isBusy };
}
