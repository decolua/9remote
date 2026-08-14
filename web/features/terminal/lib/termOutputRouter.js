import { termLog } from "@/shared/utils/termLog";
import { writeChunked, toChunk, chunkByteLength, dedupePrefix, viewportRestoreDelta, decodeMirror } from "@/features/terminal/lib/historyMirror";
import { classifyLiveChunk, syncAfterReplay, GAP_DETECTED, GAP_STALE } from "@/features/terminal/lib/seqGap";

// Output routing for a terminal pane: b64 decode, then in order — history prefix replay,
// join replay, gap chunk, join-queue, gap-queue, seq classification, live write.
//
// deps:
//   sessionId, term, writeBatcherRef
//   gapFetch   — the createGapFetch() instance ({ handleGapChunk, queueLive, start })
//   refs       — { joiningRef, joinQueueRef, lastSeqRef, lastOutputAtRef, outputTotalRef,
//                  awaitingTuiOutputRef, userAtTopRef, historyFetchingRef, historyHaveAtEmitRef,
//                  historyTotalRef, historyMirrorRef, historyBytesRef }
//   setHistoryFetching — local loading-indicator setter
export function createOutputRouter({ sessionId, term, writeBatcherRef, gapFetch, refs, setHistoryFetching }) {

  // Replay the full mirror after prepending an older-history prefix (scroll-up fetch).
  // xterm has no prepend API → reset + rewrite. ANSI is stateful so we must replay all.
  const replayWithPrefix = (prefixData) => {
    let prefixChunk = toChunk(prefixData);
    // Preserve the user's viewport row: after replay the older chunk sits above, so the same
    // content sits at (oldViewportY + measuredChunkLines).
    const oldViewportY = term.buffer.active.viewportY;
    const baseYBefore = term.buffer.active.baseY;
    // Drop the live-output overlap that landed between emit and ack (see dedupePrefix)
    prefixChunk = dedupePrefix(prefixChunk, {
      haveAtEmit: refs.historyHaveAtEmitRef.current,
      historyBytes: refs.historyBytesRef.current
    });
    refs.historyHaveAtEmitRef.current = 0;

    const chunkLen = chunkByteLength(prefixChunk);

    // Empty prefix (daemon had <1 line older than what we hold) — don't reset+rewrite the
    // whole mirror just to add nothing; that yanks the viewport for no content gain.
    if (chunkLen === 0) {
      refs.historyFetchingRef.current = false;
      setHistoryFetching(false);
      return;
    }

    refs.historyMirrorRef.current.unshift(prefixChunk);
    refs.historyBytesRef.current += chunkLen;

    term.reset();
    term.write(decodeMirror(refs.historyMirrorRef.current), () => {
      requestAnimationFrame(() => {
        // delta < 0 → scroll back up to the user's prior position via xterm's normal
        // user-scroll path (no _sync override like scrollToLine).
        const delta = viewportRestoreDelta({
          oldViewportY,
          baseYBefore,
          baseYAfter: term.buffer.active.baseY
        });
        if (delta < 0) term.scrollLines(delta);
        refs.historyFetchingRef.current = false;
        setHistoryFetching(false);
      });
    });
  };

  const handleOutput = (payload) => {
    if (payload.sessionId !== sessionId) return;
    refs.lastOutputAtRef.current = Date.now();
    const dlen = payload.data?.length || 0;
    refs.outputTotalRef.current += dlen;
    // Live output spams the buffer (agent streams many chunks/sec) — only log anomalies
    if (payload.replay || payload.isHistoryPrefix) {
      termLog("recv", `len=${dlen} replay=${!!payload.replay} prefix=${!!payload.isHistoryPrefix} total=${refs.outputTotalRef.current}`);
    }
    let data = payload.data;
    // Daemon marks coalesced/optimized output with enc:"b64" (base64 string).
    if (payload.enc === "b64" && typeof data === "string") {
      // Native base64 decode (~5-9x faster than atob+char-loop) — Chrome 133+, Safari 18.2+.
      if (typeof Uint8Array.fromBase64 === "function") {
        data = Uint8Array.fromBase64(data);
      } else {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        data = bytes;
      }
    }
    refs.awaitingTuiOutputRef.current = false; // SGR round-trip done → resume TUI scroll

    // Older-than-tail prefix (scroll-up fetch): splice before mirror, reset+replay once.
    if (payload.isHistoryPrefix) {
      replayWithPrefix(data);
      return;
    }

    // Join-replay packet (mode restore + tail): write immediately in arrival order. No mirror —
    // the tail is the post-reset baseline; mirroring would double-count it.
    if (payload.replay) {
      const d = toChunk(data);
      writeBatcherRef.current?.write(d);
      writeBatcherRef.current?.flush();
      // Resync lastSeq to the snapshot so the next live chunk is contiguous.
      if (payload.seq != null) refs.lastSeqRef.current = syncAfterReplay(payload.seq);
      return;
    }

    // Gap-recovery chunk (plan G): append to fill a missing range — no reset, no flash.
    // Mirrored like live output (these ARE live bytes we simply missed), so historyBytes
    // stays in step with the daemon's byte total. Rejected chunks (no fetch in flight,
    // out of range, retransmit) are dropped — never treated as live output.
    if (payload.gap) {
      gapFetch.handleGapChunk(data, payload.seq);
      return;
    }

    // Live output racing the join → queue, flush on ack. Dropping loses content produced
    // after the daemon's snapshot (window can be hundreds of ms under multi-pane joins).
    if (refs.joiningRef.current) {
      refs.joinQueueRef.current.push({ data, seq: payload.seq });
      return;
    }

    // Live output while a gap fetch is in flight → queue, flush after the gap lands
    // so order stays [gap … queued live] without a flash.
    if (gapFetch.queueLive(data, payload.seq)) return;

    // Seq gap detection (plan F): agent stamps seq on live chunks. A gap means output was
    // lost during a background suspension the warm heuristic missed. No seq field (old
    // agent) → skip. STALE (duplicate/late/reordered) → drop, the bytes were already rendered.
    if (payload.seq != null) {
      const verdict = classifyLiveChunk(refs.lastSeqRef.current, payload.seq);
      if (verdict === GAP_DETECTED) {
        // Hold this chunk (and any later live) until the gap lands.
        gapFetch.start(payload.seq - 1, [{ data, seq: payload.seq }]);
        return;
      }
      if (verdict === GAP_STALE) return;
      // INIT or NONE → advance and render below
      refs.lastSeqRef.current = payload.seq;
    }

    // Live output arrives → user is effectively at bottom; clear the user-scrolled-to-top flag.
    refs.userAtTopRef.current = false;
    writeChunked(term, data, refs.historyMirrorRef, refs.historyBytesRef, writeBatcherRef.current);
  };

  return { handleOutput, replayWithPrefix };
}
