import { useEffect, useRef, useState } from "preact/hooks";
import Icon from "./Icon";
import "@xterm/xterm/css/xterm.css";
import {
  resolveTheme,
  SCROLL_THRESHOLD,
  createTerminal,
  attachTouchScroll,
  bindOutput,
  joinSession,
  bindReconnect,
  bindVisibilityRepaint,
  isUserTyping,
  byteLength,
} from "@shared/terminal/index.js";
import { useFileSocket } from "../lib/fileExplorer/useFileSocket";
import { WATCH_DEBOUNCE_MS, MAX_CHANGED_BADGE } from "../lib/fileExplorer/constants";
import { HISTORY_FETCH } from "../lib/constants";

// Single xterm pane bound local socket — direct protocol (output/input/resize/joinSession).
// Core logic lives in @shared/terminal; this component only wires Preact lifecycle.
export default function TerminalPane({ socket, sessionId, theme = "dark", isFocused, cwd, onActivate, onInput, onOpenFiles, onOpenGit, onCwd, showFocusBorder, showDoneBorder }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Scrollback history mirror — raw bytes written to XTerm, replayed after fetching an older prefix on scroll-up.
  const historyMirrorRef = useRef([]);
  const historyBytesRef = useRef(0);
  const historyTotalRef = useRef(0);
  const historyFetchingRef = useRef(false);
  const historyLastFetchRef = useRef(0);
  const historyHaveAtEmitRef = useRef(0); // historyBytesRef snapshot at requestHistory emit (race-dedup)
  const userAtTopRef = useRef(false);
  const maybeFetchHistoryRef = useRef(null);
  const [historyFetching, setHistoryFetching] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !socket || !sessionId) return;

    const { term, fitAddon, doFit, dispose } = createTerminal(containerRef.current, { theme });
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Resize observer → debounced fit + emit resize
    let resizeTimer = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
          socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
        });
      }, 150);
    });
    ro.observe(containerRef.current);

    // Replay full mirror after prepending an older-history prefix (scroll-up fetch).
    // xterm has no prepend API → reset + rewrite. ANSI is stateful so we must replay all.
    const replayWithPrefix = (prefixData) => {
      let prefixChunk;
      if (prefixData instanceof ArrayBuffer || ArrayBuffer.isView(prefixData)) {
        prefixChunk = prefixData instanceof Uint8Array ? prefixData : new Uint8Array(prefixData);
      } else {
        prefixChunk = String(prefixData);
      }
      // Race-dedup: daemon computes the prefix range against the `have` we SENT, but live PTY
      // output can land in our tail between emit and ack → daemon's endExclusive shifts past
      // our current tail, so the prefix's tail end re-covers bytes already mirrored. Drop that
      // overlap (liveDelta = bytes pushed since emit) before prepending, else a few lines dup.
      const liveDelta = Math.max(0, historyHaveAtEmitRef.current > 0 ? historyBytesRef.current - historyHaveAtEmitRef.current : 0);
      historyHaveAtEmitRef.current = 0;
      if (liveDelta > 0) {
        const keep = Math.max(0, (typeof prefixChunk === "string" ? byteLength(prefixChunk) : prefixChunk.byteLength) - liveDelta);
        prefixChunk = typeof prefixChunk === "string" ? prefixChunk.slice(0, keep) : prefixChunk.subarray(0, keep);
      }
      const chunkLen = typeof prefixChunk === "string" ? byteLength(prefixChunk) : prefixChunk.byteLength;
      // Empty prefix — don't reset+rewrite just to add nothing; that yanks the viewport for no gain.
      if (chunkLen === 0) { historyFetchingRef.current = false; setHistoryFetching(false); return; }

      // Preserve viewport: after replay the older chunk sits above, so same content is at (oldY + chunkLines).
      const oldViewportY = term.buffer.active.viewportY;
      const baseYBefore = term.buffer.active.baseY;

      historyMirrorRef.current.unshift(prefixChunk);
      historyBytesRef.current += chunkLen;

      term.reset();
      const decoder = new TextDecoder();
      const parts = historyMirrorRef.current.map((c) => (typeof c === "string" ? c : decoder.decode(c, { stream: true })));
      term.write(parts.join(""), () => {
        requestAnimationFrame(() => {
          const baseYAfter = term.buffer.active.baseY;
          const actualChunkLines = Math.max(0, baseYAfter - baseYBefore);
          const target = Math.max(0, Math.min(oldViewportY + actualChunkLines, baseYAfter));
          const delta = target - baseYAfter; // negative → scroll up
          if (delta < 0) term.scrollLines(delta);
          historyFetchingRef.current = false;
          setHistoryFetching(false);
        });
      });
    };

    const unbindOutput = bindOutput(term, socket, sessionId, onCwd, {
      mirror: historyMirrorRef,
      mirrorBytes: historyBytesRef,
      onPrefix: replayWithPrefix,
    });

    const checkScroll = () => {
      const b = term.buffer.active;
      setShowScrollBtn(b.baseY - b.viewportY > SCROLL_THRESHOLD);
    };

    // Detect scroll near top (primary buffer only) → fetch older history chunk from agent.
    const maybeFetchHistory = () => {
      const buf = term.buffer.active;
      if (HISTORY_FETCH.disabled) return;
      if (historyFetchingRef.current) return;
      if (buf.type === "alternate") return;
      if (historyTotalRef.current <= 0) return;
      if (historyTotalRef.current - historyBytesRef.current < HISTORY_FETCH.minFetchBytes) return;
      const now = Date.now();
      if (now - historyLastFetchRef.current < HISTORY_FETCH.guardMs) return;
      // Only fetch when user actively scrolled to top — viewportY is transiently 0 right after mount/write.
      if (!userAtTopRef.current) return;
      if (buf.viewportY > HISTORY_FETCH.topThresholdLines) { userAtTopRef.current = false; return; }

      historyFetchingRef.current = true;
      historyLastFetchRef.current = now;
      historyHaveAtEmitRef.current = historyBytesRef.current;
      setHistoryFetching(true);
      socket.emit("requestHistory", { sessionId, have: historyHaveAtEmitRef.current }, (result) => {
        if (!result || !result.success) { historyFetchingRef.current = false; setHistoryFetching(false); return; }
        if (!result.prefixLen) { historyFetchingRef.current = false; setHistoryFetching(false); }
        historyTotalRef.current = result.total || historyTotalRef.current;
      });
    };
    maybeFetchHistoryRef.current = maybeFetchHistory;

    const scrollDisp = term.onScroll(() => { checkScroll(); maybeFetchHistory(); });
    const writeDisp = term.onWriteParsed(checkScroll);

    const doJoin = () => {
      // Fit first so daemon serializes the snapshot at the client's real size (alt-screen TUI wraps by cols)
      doFit();
      socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
      // Reset before replay so serialized snapshot (incl. alt-screen) paints on a clean buffer
      term.reset();
      // Reset history mirror — rejoin starts fresh with the tail replay.
      historyMirrorRef.current = [];
      historyBytesRef.current = 0;
      historyTotalRef.current = 0;
      historyFetchingRef.current = false;
      userAtTopRef.current = false;
      joinSession(socket, sessionId, {
        onSuccess: (res) => {
          historyTotalRef.current = res?.total || 0;
          setTimeout(doFit, 100);
        },
        onError: (msg) => term.write(`\r\n\x1b[1;31mError: ${msg}\x1b[0m\r\n`),
      });
    };
    doJoin();
    if (isFocused) term.focus();

    const unbindReconnect = bindReconnect(term, socket, doJoin);
    const unbindVisibility = bindVisibilityRepaint(term);

    const screen = term.element?.querySelector(".xterm-screen");
    const sendInput = (data) => socket.emit("input", { sessionId, data });
    const onScrollUp = { thresholdLines: HISTORY_FETCH.topThresholdLines, fire: () => { userAtTopRef.current = true; maybeFetchHistoryRef.current?.(); } };
    const detachTouch = screen ? attachTouchScroll(term, screen, sendInput, { onScrollUp }) : () => {};

    // Desktop wheel — when scrolled to top, fetch older history chunk
    const handleWheel = (e) => {
      if (e.deltaY < 0 && term.buffer.active.viewportY <= HISTORY_FETCH.topThresholdLines) {
        userAtTopRef.current = true;
        maybeFetchHistoryRef.current?.();
      }
    };
    if (screen) screen.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      ro.disconnect();
      unbindOutput();
      unbindReconnect();
      unbindVisibility();
      detachTouch();
      if (screen) screen.removeEventListener("wheel", handleWheel);
      if (resizeTimer) clearTimeout(resizeTimer);
      scrollDisp.dispose();
      writeDisp.dispose();
      dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]);

  // Input handler — separate effect so focus change rebinds (web parity)
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId || !isFocused) return;
    const handler = termRef.current.onData((data) => { if (isUserTyping(data)) onInput?.(sessionId); socket.emit("input", { sessionId, data }); });
    return () => handler.dispose();
  }, [isFocused, socket, sessionId, onInput]);

  // Theme switch
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTheme(theme);
  }, [theme]);

  // Focus → also refit (layout may have changed since last visible)
  useEffect(() => {
    if (!isFocused || !termRef.current) return;
    termRef.current.focus();
    const timer = setTimeout(() => {
      const fitAddon = fitAddonRef.current;
      const term = termRef.current;
      if (!fitAddon || !term || !containerRef.current?.offsetWidth) return;
      fitAddon.fit();
      socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
    }, 100);
    return () => clearTimeout(timer);
  }, [isFocused, sessionId, socket]);

  const scrollToBottom = () => termRef.current?.scrollToBottom();
  // Done-border + focus glow coexist (different pseudo-elements on the same node)
  const glow = [
    showDoneBorder ? "terminal-done-border" : "",
    showFocusBorder && isFocused ? "terminal-focus-glow" : ""
  ].filter(Boolean).join(" ");

  // Watch cwd + track changed-files count via git status (debounced on fs events)
  const fileSocket = useFileSocket();
  const [changedCount, setChangedCount] = useState(0);
  useEffect(() => {
    if (!cwd || !isFocused) return;
    let timer = null;
    const refresh = async () => {
      const res = await fileSocket.gitChangedCount(cwd);
      if (res?.success) setChangedCount(res.count || 0);
    };
    const onFileChange = () => { clearTimeout(timer); timer = setTimeout(refresh, WATCH_DEBOUNCE_MS); };
    fileSocket.watchDir(cwd);
    socket.on("fileChange", onFileChange);
    refresh();
    return () => { clearTimeout(timer); socket.off("fileChange", onFileChange); fileSocket.unwatchDir(cwd); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, isFocused, socket]);
  const badgeLabel = changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount;

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden relative ${glow}`}
      style={{ background: resolveTheme(theme).background }}
      onMouseDown={() => { if (!isFocused) onActivate?.(sessionId); }}
    >
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden px-1 py-0.5 relative">
        <div ref={containerRef} className="w-full h-full" />
        {historyFetching && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full shadow-md text-xs"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
            >
              <span
                className="w-3 h-3 border-2 rounded-full inline-block animate-spin"
                style={{ borderColor: "var(--brand-500)", borderTopColor: "transparent" }}
              />
              Loading history…
            </div>
          </div>
        )}
        {cwd && isFocused && (
          <div className="absolute top-2 right-2 z-50 flex flex-col gap-2">
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); onOpenFiles?.(cwd); }}
              className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title="Open file explorer"
            >
              <Icon name="folder" size={16} />
            </button>
            {changedCount > 0 && (
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); onOpenGit?.(cwd); }}
                className="relative p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
                title="Changed files"
              >
                <Icon name="gitBranch" size={16} />
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                  {badgeLabel}
                </span>
              </button>
            )}
          </div>
        )}
        {showScrollBtn && (
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); scrollToBottom(); }}
            className="absolute bottom-5 right-7 z-50 p-2 rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
            style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
            title="Scroll to bottom"
          >
            <Icon name="chevronDown" size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
