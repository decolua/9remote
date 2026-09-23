import { termLog } from "@/shared/utils/termLog";
import { writeChunked } from "@/features/terminal/lib/historyMirror";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { STARTUP_CMD_DELAY_MS, JOIN_ACK_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";

// joinSession flow: replay-window management + the emit/ack round-trip. Live output racing
// the replay is QUEUED (not written) so it never lands between term.reset() and the
// mode-restore replay packet; the ack flushes it in arrival order.
//
// deps:
//   bus, sessionId, term, fitAddon
//   writeBatcherRef — rAF batcher (stable ref)
//   doResizeRef     — settle-debounce resize; join delegates size negotiation to it
//   fireJoinRef     — receives the fireJoin(cols, rows) closure (called by doResize settle)
//   refs            — { historyMirrorRef, historyBytesRef, historyTotalRef, historyFetchingRef,
//                       userAtTopRef, joiningRef, joinClaimedRef, joinQueueRef, joinGenRef,
//                       lastSeqRef, cwdRef, setJoining }
//   setCwd          — local reactive cwd setter
export function createJoinSession({ bus, sessionId, term, fitAddon, writeBatcherRef, doResizeRef, fireJoinRef, refs, setCwd }) {
  let joinTimer = null;

  const doJoinSession = (isRejoin = false) => {
    // Reset history mirror — rejoin starts fresh with the tail replay.
    refs.historyMirrorRef.current = [];
    refs.historyBytesRef.current = 0;
    refs.historyTotalRef.current = 0;
    refs.historyFetchingRef.current = false;
    refs.userAtTopRef.current = false;
    // Fit + emit resize BEFORE join so the daemon serializes the TUI snapshot (alt-screen
    // apps like Claude Code) at the client's real size — a snapshot at a transient cols
    // re-wraps scrollback narrow FOREVER (PTY cols is one-way). Delegate to
    // doResize({join:true}): RO + the settle debounce fire emit+join at the real size.
    requestAnimationFrame(() => doResizeRef.current?.({ join: true }));
    const fireJoin = (cols, rows) => {
      // Send the measured size in the join so a respawned PTY spawns at the right size
      // (only when the agent advertises the capability — older agents expect a bare string).
      const joinPayload = useTerminalStore.getState().agentCaps?.joinSessionSize
        ? { sessionId, cols, rows }
        : sessionId;
      refs.joiningRef.current = true;
      refs.setJoining(true);
      refs.joinQueueRef.current = [];
      const myGen = ++refs.joinGenRef.current;
      termLog("join", `emit gen=${myGen} sid=${String(sessionId).slice(-8)} cols=${cols} rows=${rows}`);

      // ponytail: 8s safety ceiling; upgrade path is bus-level ack retry + carrier fallback
      if (joinTimer) clearTimeout(joinTimer);
      joinTimer = setTimeout(() => {
        joinTimer = null;
        if (myGen !== refs.joinGenRef.current) return;
        termLog("join", `ack timeout gen=${myGen} (${JOIN_ACK_TIMEOUT_MS}ms) → clear spinner`);
        refs.joiningRef.current = false;
        refs.joinClaimedRef.current = false;
        refs.setJoining(false);
        const queue = refs.joinQueueRef.current;
        refs.joinQueueRef.current = [];
        const b = writeBatcherRef.current;
        for (const q of queue) {
          const d = (q && typeof q === "object" && "data" in q) ? q.data : q;
          writeChunked(term, d, refs.historyMirrorRef, refs.historyBytesRef, b);
        }
        b?.flush();
      }, JOIN_ACK_TIMEOUT_MS);

      bus.emit("joinSession", joinPayload, (result) => {
        if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
        if (myGen !== refs.joinGenRef.current) { termLog("join", `stale ack gen=${myGen} (current=${refs.joinGenRef.current})`); return; }
        const res = result || {};
        termLog("join", `ack gen=${myGen} sid=${String(sessionId).slice(-8)} success=${!!res.success} total=${res.total} replaySize=${res.replaySize}`);
        if (res.success) {
          // Flush queued live output (deferred one tick so any in-flight replay packet lands first).
          setTimeout(() => {
            if (myGen !== refs.joinGenRef.current || term._core?._isDisposed) return;
            const queue = refs.joinQueueRef.current;
            refs.joinQueueRef.current = [];
            const b = writeBatcherRef.current;
            let queueTailSeq = null;
            for (const q of queue) {
              const d = (q && typeof q === "object" && "data" in q) ? q.data : q; // {data,seq} | raw
              if (q?.seq != null) queueTailSeq = q.seq;
              writeChunked(term, d, refs.historyMirrorRef, refs.historyBytesRef, b);
            }
            // Resync lastSeq: ack carries the snapshot seq; queued live may extend past it.
            // Take the larger so the next live chunk classifies as contiguous.
            const ackSeq = res.seq ?? null;
            if (ackSeq != null || queueTailSeq != null) {
              refs.lastSeqRef.current = Math.max(ackSeq ?? -1, queueTailSeq ?? -1);
            }
            b?.flush();
            refs.joiningRef.current = false;
            refs.joinClaimedRef.current = false; // the join is done — the recovery lane is free
            refs.setJoining(false);
          }, 0);
          // total = bytes agent holds; ceiling for scroll-up fetch.
          refs.historyTotalRef.current = res.total || 0;
          if (res.cwd) { refs.cwdRef.current = res.cwd; setCwd(res.cwd); useTerminalStore.getState().setCwd(sessionId, res.cwd); }
          // One-shot agent-CLI startup command (new-terminal modal). Consume-once so
          // a reconnect rejoin never re-runs it; delayed so the login shell reaches
          // its prompt before the TUI boots.
          const startupCmd = useTerminalStore.getState().consumeStartup(sessionId);
          if (startupCmd) {
            termLog("join", `startup cmd queued (${startupCmd})`);
            setTimeout(() => bus.emit("input", { sessionId, data: `${startupCmd}\r` }), STARTUP_CMD_DELAY_MS);
          }
          setTimeout(() => fitAddon.fit(), 200);
        } else {
          if (res.error === "rtc-closed") {
            termLog("join", "rtc-closed during join ack → retry via fallback carrier");
            doJoinSession(true);
            return;
          }
          refs.joiningRef.current = false;
          refs.joinClaimedRef.current = false;
          refs.setJoining(false);
          refs.joinQueueRef.current = [];
          term.write(`\r\n\x1b[1;31mError: ${res.error || "Failed to join session"}\x1b[0m\r\n`);
        }
      });
    };
    fireJoinRef.current = fireJoin;
  };

  return doJoinSession;
}
