"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon, BrowserClipboardProvider } from "@xterm/addon-clipboard";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import { THEMES, resolveTerminalTheme } from "@/features/terminal/constants/themes";
import { vibrate } from "@/shared/utils/vibration";
import { termLog } from "@/shared/utils/termLog";
import { TERMINAL_OPTIONS, RENDERER, ADDONS, isUserTyping, TOUCH_SCROLL, TOUCH_SELECT, HISTORY_FETCH, MIN_COLS, MIN_ROWS, SETTLE_DEBOUNCE_MS, ORIENTATION_SETTLE_MS, RECONNECT_WARM_MS } from "@/features/terminal/constants/terminalConfig";
import { resetReconnectState } from "@/features/terminal/lib/reconnectState";
import { createWriteBatcher } from "@/features/terminal/lib/termWriteBatcher";
import { trimEndToEsc } from "@/features/terminal/lib/ansiBoundary";

import { useTerminalStore } from "@/shared/stores/terminalStore";
// import { detectLinks } from "@/features/terminal/utils/linkDetector";

// Write output via the rAF batcher when provided (coalesces bursts into one write/frame so the
// main thread isn't blocked parsing each 1KB chunk), else direct term.write. mirror/mirrorBytes:
// refs to accumulate raw bytes for scroll-up history replay (null = skip mirroring).
function writeChunked(term, data, mirror, mirrorBytes, batcher) {
  if (!term || term._core?._isDisposed) return;
  if (batcher) batcher.write(data);
  else term.write(data);

  // Mirror output for history replay — keep raw bytes (Uint8Array/string) so we can splice prefix later.
  if (mirror) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      mirror.current.push(chunk);
      mirrorBytes.current += chunk.length; // Uint8Array.length === byteLength ✓
    } else if (typeof data === "string") {
      mirror.current.push(data);
      // Count BYTES not UTF-16 code units — multibyte (CJK/emoji) must match daemon's byte total.
      mirrorBytes.current += BufferLikeByteLength(data);
    }
  }
}

// Byte length of a string in UTF-8 — matches the daemon's Buffer byte count so `have`/`total`
// stay consistent across multibyte output. Uses TextEncoder (browser) or Buffer (node).
const _utf8Encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
function BufferLikeByteLength(str) {
  if (!str) return 0;
  if (_utf8Encoder) return _utf8Encoder.encode(str).length;
  return Buffer.byteLength(str, "utf-8"); // node fallback
}
// isVisible: pane is shown (desktop: always true for opened panes, mobile: only active)
// isFocused: pane receives keyboard input (only one pane focused at a time)
export function useXTerm({ socket, sessionId, theme, terminalTheme, isVisible, isFocused, containerRef, mountDelay = 0, onInput, onSelectionMade }) {
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const writeBatcherRef = useRef(null);
  const webglAddonRef = useRef(null);
  const loadWebGLRef = useRef(null);
  const disposeWebGLRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const doResizeRef = useRef(null);
  const doJoinSessionRef = useRef(null); // reload() calls this — no full socket reconnect
  const fireJoinRef = useRef(null);      // emit joinSession at a size (set by doJoinSession, called by settle)
  const forceNextRef = useRef(false);   // doResize({force}) flag carried into the settle timer
  const joinNextRef = useRef(false);    // doResize({join}) flag — fire a deferred join at settled size
  const stopMomentumRef = useRef(null);
  const cwdRef = useRef(null); // Track current working directory
  const [cwd, setCwd] = useState(null); // Reactive cwd for toolbar UI
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const fontSizeSetting = useTerminalStore((s) => s.fontSize);
  const onSelectionMadeRef = useRef(onSelectionMade);
  useEffect(() => { onSelectionMadeRef.current = onSelectionMade; }, [onSelectionMade]);
  const awaitingTuiOutputRef = useRef(false); // SGR emit→output round-trip tracker (TUI backpressure)
  const searchAddonRef = useRef(null);
  const [termReady, setTermReady] = useState(false);

  // Last PTY size sent — skip emit when fit yields same cols/rows (soft-KB with fixed pane height)
  const lastPtySizeRef = useRef(null);

  // Scrollback history mirror — raw bytes written to XTerm, so we can replay after
  // fetching an older prefix on scroll-up. have = bytes currently mirrored.
  const historyMirrorRef = useRef([]); // array of Uint8Array/string chunks
  const historyBytesRef = useRef(0);   // total mirrored bytes
  const historyTotalRef = useRef(0);   // bytes agent reports holding (ceiling)
  const historyFetchingRef = useRef(false); // in-flight requestHistory
  const historyLastFetchRef = useRef(0);    // timestamp of last fetch (guard)
  const historyHaveAtEmitRef = useRef(0);   // historyBytesRef snapshot at requestHistory emit (race-dedup)
  // Join-replay window: while a joinSession round-trip is in flight (emit → replay → ack), LIVE
  // output is QUEUED (not written) so it never lands between term.reset() and the mode-restore
  // replay packet. Dropping was wrong — the window can last hundreds of ms under multi-pane joins
  // (5×131KB tail replays), so live output produced AFTER the daemon's snapshot would be lost
  // forever. Queue + flush on ack: replay paints first, queued live follows in arrival order.
  const joiningRef = useRef(false);
  const [joining, setJoining] = useState(false); // reactive for center loading spinner during join
  const joinQueueRef = useRef([]);
  const joinGenRef = useRef(0); // stale-ack guard: only the current join's ack clears the spinner
  const scrollDisposeRef = useRef(null);    // disposable from term.onScroll
  const needsRejoinRef = useRef(false);     // reconnect fired while pane hidden → defer rejoin until visible
  const isVisibleRef = useRef(isVisible);   // mirror isVisible for socket handlers
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  const [historyFetching, setHistoryFetching] = useState(false); // loading indicator state
  const maybeFetchHistoryRef = useRef(null); // shared with touch/wheel scroll handlers in other effects
  const userAtTopRef = useRef(false); // set true only when user actively scrolls up to top (not mount transient)
  const lastOutputAtRef = useRef(0);  // ts of last live output — warm gate for reconnect skip
  const outputTotalRef = useRef(0);   // bytes received this session — dup detector (agent sends 1, we get 2)

  // Emit resize only if cols/rows are above the sane-size floor. A transient tiny size
  // (layout mid-transition, app-resume reconnect) makes the shell re-wrap scrollback
  // narrow forever — older lines stay narrow even after cols return to normal.
  const emitResize = useCallback(() => {
    const term = termRef.current;
    if (!term || !socket) return;
    const { cols, rows } = term;
    if (cols < MIN_COLS || rows < MIN_ROWS) return;
    lastPtySizeRef.current = { cols, rows };
    socket.emit("resize", { sessionId, cols, rows });
  }, [socket, sessionId]);

  // Settle-and-emit: single debounce (SETTLE_DEBOUNCE_MS) after the LAST layout change.
  // Each call resets the timer → fires only when the container has been quiet for the full
  // debounce, i.e. the mount/group-switch/soft-KB storm is truly over. Then fit once + emit at
  // the settled size. PTY cols is one-way (a transient narrow cols re-wraps scrollback narrow
  // FOREVER) so we never accept a mid-transition size — the debounce IS the stability gate,
  // event-driven via ResizeObserver, no frame polling, no cap to fall through.
  // opts.force: always emit even if size unchanged (reconnect/redraw). opts.join: also fire the
  // deferred join at this size (initial mount / group switch).
  const doResize = useCallback((opts = {}) => {
    const force = opts === true || opts?.force === true;
    const join = !!opts?.join;
    if (force) forceNextRef.current = true;
    if (join) joinNextRef.current = true;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      const el = containerRef.current;
      if (!term || term._isDisposed || !fitAddon || !socket) return;
      if (!el?.offsetWidth || !el?.offsetHeight) return; // not laid out yet → RO will re-kick
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols < MIN_COLS || rows < MIN_ROWS) return; // mid-transition → RO will re-kick
      const prev = lastPtySizeRef.current;
      const force = forceNextRef.current;
      const wantJoin = joinNextRef.current;
      forceNextRef.current = false;
      joinNextRef.current = false;
      if (!force && prev && prev.cols === cols && prev.rows === rows && !wantJoin) return;
      lastPtySizeRef.current = { cols, rows };
      socket.emit("resize", { sessionId, cols, rows });
      if (wantJoin && fireJoinRef.current) {
        term.reset();
        fireJoinRef.current(cols, rows);
      }
    }, SETTLE_DEBOUNCE_MS);
  }, [socket, sessionId, containerRef]);

  // Keep ref updated for use in useEffect without stale closure
  useEffect(() => { doResizeRef.current = doResize; }, [doResize]);

  // Initialize XTerm instance
  useEffect(() => {
    if (!containerRef.current || !socket || !sessionId) return;
    if (termRef.current) return;

    // Fresh session → no prior output; clear so a carrier switch right after join
    // can't reuse a stale warm timestamp from the previous session.
    lastOutputAtRef.current = 0;

    const term = new XTerm({
      ...TERMINAL_OPTIONS,
      fontSize: fontSizeSetting ?? (window.innerWidth < 768 ? TERMINAL_OPTIONS.fontSizeMobile : TERMINAL_OPTIONS.fontSize),
      theme: resolveTerminalTheme(theme, terminalTheme) || THEMES.dark
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Unicode v11 width tables fix CJK/combining glyph misalignment on mobile
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    // rAF write batcher — coalesce high-frequency output bursts into one write/frame so the
    // main thread isn't blocked parsing/rendering each 1KB chunk (stutters animation under load).
    const batcher = createWriteBatcher(term);
    writeBatcherRef.current = batcher;

    // Clipboard (OSC52) + search addons
    if (ADDONS.clipboard) term.loadAddon(new ClipboardAddon(undefined, new BrowserClipboardProvider()));
    if (ADDONS.search) {
      searchAddonRef.current = new SearchAddon();
      term.loadAddon(searchAddonRef.current);
    }

    // Smooth scroll only for physical mouse wheel (VS Code parity); touch keeps inertia handler
    const wheelEl = containerRef.current;
    const handleWheel = (e) => {
      term.options.smoothScrollDuration = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50
        ? RENDERER.smoothScrollDuration : 0;
    };
    wheelEl.addEventListener("wheel", handleWheel, { passive: true });

    // WebGL renderer (VS Code parity: WebGL → DOM fallback). Loaded after joinSession to avoid blank screen.
    let webglAddon = null;
    let webglFailed = false;
    const loadWebGL = () => {
      if (webglAddon || webglFailed || RENDERER.gpuAcceleration === "off") return;
      try {
        webglAddon = new WebglAddon();
        // Context loss (GPU reclaimed) → dispose, xterm auto falls back to DOM. Buffer text preserved.
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          webglAddon = null;
        });
        term.loadAddon(webglAddon);
        // Image addon only with WebGL active (VS Code parity, avoids GPU issues)
        if (ADDONS.image) term.loadAddon(new ImageAddon());
        // WebGL cell dimensions differ from DOM → re-fit after load
        fitAddon.fit();
      } catch (e) {
        webglFailed = true;
        webglAddon = null;
        console.warn("WebGL unavailable, using DOM renderer");
      }
    };
    const disposeWebGL = () => {
      if (!webglAddonRef.current) return;
      webglAddonRef.current.dispose();
      webglAddonRef.current = null;
      fitAddon.fit();
      emitResize();
      term.refresh(0, term.rows - 1);
    };

    // Expose swap fns to the toggle effect
    loadWebGLRef.current = loadWebGL;
    disposeWebGLRef.current = disposeWebGL;

    // Initial fit and mark ready
    let checkCount = 0;
    const maxChecks = 50;
    const checkReady = () => {
      checkCount++;
      const width = containerRef.current?.offsetWidth || 0;
      const height = containerRef.current?.offsetHeight || 0;
      
      if (checkCount > maxChecks) {
        setTermReady(true);
        return;
      }

      if (term.element && width >= 100 && height >= 100) {
        fitAddon.fit();
        emitResize();
        setTermReady(true);
      } else {
        setTimeout(checkReady, 50);
      }
    };
    setTimeout(checkReady, 50);

    // ResizeObserver - delegate to doResize (debounced + rAF)
    const resizeObserver = new ResizeObserver(() => doResizeRef.current?.());
    resizeObserver.observe(containerRef.current);

    // Replay full mirror after prepending an older-history prefix (scroll-up fetch).
    // xterm has no prepend API → reset + rewrite. ANSI is stateful so we must replay all.
    const replayWithPrefix = (prefixData) => {
      // Prepend prefix chunk to the mirror
      let prefixChunk;
      if (prefixData instanceof ArrayBuffer || ArrayBuffer.isView(prefixData)) {
        prefixChunk = prefixData instanceof Uint8Array ? prefixData : new Uint8Array(prefixData);
      } else {
        prefixChunk = String(prefixData);
      }
      // Preserve the user's current viewport row: after replay, the older chunk sits above,
      // so the same content is now at (oldViewportY + actualChunkLines). We MEASURE the chunk's
      // real line count (baseY after write − baseY before reset) instead of estimating from bytes
      // — ANSI escapes + wide-char wrapping make byte/cols estimates wildly wrong → viewport jump.
      const oldViewportY = term.buffer.active.viewportY;
      const baseYBefore = term.buffer.active.baseY;
      // Race-dedup: daemon computes the prefix range against the `have` we SENT, but live PTY
      // output can land in our tail between emit and ack → daemon's endExclusive shifts past
      // our current tail, so the prefix's tail end re-covers bytes already mirrored. Drop that
      // overlap (liveDelta = bytes pushed since emit) before prepending, else a few lines dup.
      const liveDelta = Math.max(0, historyHaveAtEmitRef.current > 0 ? historyBytesRef.current - historyHaveAtEmitRef.current : 0);
      historyHaveAtEmitRef.current = 0;
      if (liveDelta > 0) {
        let keep = Math.max(0, (typeof prefixChunk === "string" ? BufferLikeByteLength(prefixChunk) : prefixChunk.byteLength) - liveDelta);
        // A blind byte cut can split a trailing ANSI escape — align to a clean ESC boundary.
        if (typeof prefixChunk !== "string") keep = trimEndToEsc(prefixChunk, keep);
        prefixChunk = typeof prefixChunk === "string" ? prefixChunk.slice(0, keep) : prefixChunk.subarray(0, keep);
      }

      const chunkLen = typeof prefixChunk === "string" ? BufferLikeByteLength(prefixChunk) : prefixChunk.byteLength;

      // Empty prefix (daemon had <1 line older than what we hold) — don't reset+rewrite the
      // whole mirror just to add nothing; that yanks the viewport for no content gain.
      if (chunkLen === 0) {
        historyFetchingRef.current = false;
        setHistoryFetching(false);
        return;
      }

      historyMirrorRef.current.unshift(prefixChunk);
      historyBytesRef.current += chunkLen;

      // xterm only auto-scrolls to bottom on write when the viewport is already at the bottom.
      // After reset+write the viewport lands at the bottom (newest). To keep the user's prior
      // position, scroll back up by (actualChunkLines) via scrollLines — it goes through xterm's
      // normal user-scroll path (no _sync override like scrollToLine).
      term.reset();
      const decoder = new TextDecoder();
      const parts = historyMirrorRef.current.map((c) =>
        typeof c === "string" ? c : decoder.decode(c, { stream: true })
      );
      term.write(parts.join(""), () => {
        requestAnimationFrame(() => {
          // baseY now reflects the full replayed buffer. actualChunkLines = how many lines the
          // prefix added (measured, not estimated) → exact viewport preservation.
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

    // Detect scroll near top (primary buffer only) → fetch older history chunk from agent.
    const maybeFetchHistory = () => {
      const buf = term.buffer.active;
      if (HISTORY_FETCH.disabled) return;
      if (historyFetchingRef.current) return;
      if (buf.type === "alternate") return;
      if (historyTotalRef.current <= 0) return;
      // Skip when fewer than minFetchBytes remain — a few stray bytes (live output that landed
      // between fetches) aren't worth a full mirror reset+rewrite, which yanks the viewport.
      if (historyTotalRef.current - historyBytesRef.current < HISTORY_FETCH.minFetchBytes) return;
      const now = Date.now();
      if (now - historyLastFetchRef.current < HISTORY_FETCH.guardMs) return;
      // Only fetch when the user actively scrolled to top — viewportY is transiently 0 right
      // after mount/write, so relying on it alone would fire a fetch on every F5.
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
    scrollDisposeRef.current = term.onScroll(maybeFetchHistory);
    term.textarea?.addEventListener("keyup", maybeFetchHistory);
    maybeFetchHistoryRef.current = maybeFetchHistory;

    // Output handler - filter by sessionId
    const handleOutput = (payload) => {
      if (payload.sessionId !== sessionId) return;
      lastOutputAtRef.current = Date.now();
      const dlen = payload.data?.length || 0;
      outputTotalRef.current += dlen;
      // Live output spams the buffer (agent streams many chunks/sec) — only log
      // anomalies (rejoin replay / scroll-up prefix), not every live chunk.
      if (payload.replay || payload.isHistoryPrefix) {
        termLog("recv", `len=${dlen} replay=${!!payload.replay} prefix=${!!payload.isHistoryPrefix} total=${outputTotalRef.current}`);
      }
      let data = payload.data;
      // Daemon marks coalesced/optimized output with enc:"b64" (base64 string).
      // Decode once here → avoids double base64 in the old Buffer round-trip path.
      if (payload.enc === "b64" && typeof data === "string") {
        // Native base64 decode (~5-9x faster than atob+char-loop) — Chrome 133+, Safari 18.2+.
        // Fallback to atob for older browsers / Tauri WebViews.
        if (typeof Uint8Array.fromBase64 === "function") {
          data = Uint8Array.fromBase64(data);
        } else {
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          data = bytes;
        }
      }
      awaitingTuiOutputRef.current = false; // SGR round-trip done → resume TUI scroll

      // Older-than-tail prefix (scroll-up fetch): splice before mirror, reset+replay once.
      if (payload.isHistoryPrefix) {
        replayWithPrefix(data);
        return;
      }

      // Join-replay packet (mode restore + tail): write immediately in arrival order. No mirror —
      // the tail is the post-reset baseline; mirroring would double-count it.
      if (payload.replay) {
        const d = (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
          ? (data instanceof Uint8Array ? data : new Uint8Array(data))
          : (typeof data === "string" ? data : String(data));
        writeBatcherRef.current?.write(d);
        writeBatcherRef.current?.flush();
        return;
      }

      // Live output racing the join → queue, flush on ack. Dropping loses content produced after
      // the daemon's snapshot (window can be hundreds of ms under multi-pane joins).
      if (joiningRef.current) {
        joinQueueRef.current.push(data);
        return;
      }

      // Live output arrives → user is effectively at bottom; clear the user-scrolled-to-top flag.
      userAtTopRef.current = false;
      const b = writeBatcherRef.current;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        writeChunked(term, data instanceof Uint8Array ? data : new Uint8Array(data), historyMirrorRef, historyBytesRef, b);
      } else if (typeof data === "string") {
        writeChunked(term, data, historyMirrorRef, historyBytesRef, b);
      } else {
        writeChunked(term, String(data), historyMirrorRef, historyBytesRef, b);
      }
    };
    socket.on("output", handleOutput);

    // Server-pushed cwd change (OSC 7 detected daemon-side) — authoritative cwd source
    const handleCwdChange = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      if (payload.cwd) { cwdRef.current = payload.cwd; setCwd(payload.cwd); useTerminalStore.getState().setCwd(sessionId, payload.cwd); }
    };
    socket.on("cwdChange", handleCwdChange);

    // Join session and replay scrollback buffer from daemon
    const doJoinSession = (isRejoin = false) => {
      // Reset history mirror — rejoin starts fresh with the tail replay.
      historyMirrorRef.current = [];
      historyBytesRef.current = 0;
      historyTotalRef.current = 0;
      historyFetchingRef.current = false;
      userAtTopRef.current = false;
      // Fit + emit resize BEFORE join so the daemon serializes the TUI snapshot
      // (alt-screen apps like Claude Code) at the client's real size. Join-first would
      // replay at the daemon's stale cols/rows → garbled until next SIGWINCH.
      // The container is briefly narrow during mount-in / group-switch. A snapshot taken at a
      // transient cols re-wraps scrollback narrow FOREVER (PTY cols is one-way). So don't poll
      // here — delegate to doResize({join:true}): ResizeObserver + the settle debounce fire the
      // emit+join once the container has been quiet for the full debounce, at the real size.
      requestAnimationFrame(() => doResizeRef.current?.({ join: true }));
      // Emit joinSession with the given size (used by the reconnect/visibility paths).
      const fireJoin = (cols, rows) => {
        // Send the measured size in the join so a respawned PTY spawns at the right size.
        // Only when the agent advertises the capability — older agents expect a bare
        // sessionId string and would treat an object as an unknown session.
        const joinPayload = useTerminalStore.getState().agentCaps?.joinSessionSize
          ? { sessionId, cols, rows }
          : sessionId;
        // Open the drop window — live output racing the replay is dropped (already in the tail).
        joiningRef.current = true;
        setJoining(true);
        joinQueueRef.current = [];
        const myGen = ++joinGenRef.current;
        termLog("join", `emit gen=${myGen} cols=${cols} rows=${rows}`);
        socket.emit("joinSession", joinPayload, (result) => {
          if (myGen !== joinGenRef.current) { termLog("join", `stale ack gen=${myGen} (current=${joinGenRef.current})`); return; }
          termLog("join", `ack gen=${myGen} success=${!!result?.success} total=${result?.total} replaySize=${result?.replaySize}`);
          // Flush queued live output (deferred one tick so any in-flight replay packet lands first).
          setTimeout(() => {
            joiningRef.current = false;
            setJoining(false);
            const queue = joinQueueRef.current;
            joinQueueRef.current = [];
            const b = writeBatcherRef.current;
            for (const q of queue) {
              if (q instanceof ArrayBuffer || ArrayBuffer.isView(q)) {
                writeChunked(term, q instanceof Uint8Array ? q : new Uint8Array(q), historyMirrorRef, historyBytesRef, b);
              } else {
                writeChunked(term, typeof q === "string" ? q : String(q), historyMirrorRef, historyBytesRef, b);
              }
            }
            // Force a flush so queued content paints this frame instead of waiting for the next rAF.
            b?.flush();
          }, 0);
          if (result.success) {
            // total = bytes agent holds; ceiling for scroll-up fetch.
            historyTotalRef.current = result.total || 0;
            if (result.cwd) { cwdRef.current = result.cwd; setCwd(result.cwd); useTerminalStore.getState().setCwd(sessionId, result.cwd); }
            setTimeout(() => {
              // WebGL renderer applied by the webglEnabled watch effect below; just fit.
              fitAddon.fit();
            }, 200);
          } else {
            term.write(`\r\n\x1b[1;31mError: ${result.error}\x1b[0m\r\n`);
          }
        });
      };
      fireJoinRef.current = fireJoin;
    };
    // Stagger initial join by mountDelay so a freshly-entered group's panes don't all join at once
    // (focus pane = 0ms, siblings stagger ~120ms). Rejoins/visibility-driven calls pass 0.
    if (mountDelay > 0) {
      const id = setTimeout(doJoinSession, mountDelay);
      doJoinSessionRef.current = doJoinSession;
      return () => clearTimeout(id); // unmount before fire → cancel
    }
    doJoinSession();
    doJoinSessionRef.current = doJoinSession;

    // On reconnect → clear stale content and rejoin to get latest scrollback.
    // BUT only if the pane is visible — a hidden pane (different group, LRU) has a stale/
    // zero-size container; fitting+joining now would serialize the TUI snapshot at a wrong cols
    // and Claude Code's restored output renders narrow forever. Defer to the visibility effect.
    const handleReconnect = () => {
      if (!termRef.current) return;
      // Reset transient state that may be stuck from the disconnect: mid-flight
      // requestHistory (R2) and mid-SGR TUI round-trip (R3). R4 (lastPtySize dedup)
      // is handled in the settle path (doResize), which records the size it emits.
      resetReconnectState({
        historyFetching: historyFetchingRef,
        historyHaveAtEmit: historyHaveAtEmitRef,
        awaitingTuiOutput: awaitingTuiOutputRef,
        joining: joiningRef,
        joinQueue: joinQueueRef,
      });
      setHistoryFetching(false);
      setJoining(false); // rejoin below will set it true again on emit
      if (!isVisibleRef.current) { needsRejoinRef.current = true; termLog("reconnect", "deferred (pane hidden) → needsRejoin=true"); return; }
      // Warm reconnect: live output arrived recently → agent still streaming over the
      // new carrier, no scrollback gap. Skip reset+rejoin (which clears xterm = white
      // flash) and let output continue. Only reset when stale (real disconnect gap).
      // Don't skip mid-join: the in-flight join's replay packets write on the current
      // buffer and would duplicate without the reset. Let it reset+rejoin clean.
      const sinceOutput = Date.now() - lastOutputAtRef.current;
      if (!joiningRef.current && sinceOutput < RECONNECT_WARM_MS) {
        termLog("reconnect", `warm skip (${sinceOutput}ms < ${RECONNECT_WARM_MS})`);
        return;
      }
      termLog("reconnect", `reset+rejoin (sinceOutput=${sinceOutput}ms joining=${joiningRef.current})`);
      termRef.current.reset();
      doJoinSession(true);
    };
    socket.on("connect", handleReconnect);

    // Orientation change: wait for mobile layout to settle, then force-refit + re-emit cols.
    // RO may not fire (container height locked against soft-KB shrink) or fire mid-transition
    // with a stale width → cols lock to wrong value, content renders narrower than container.
    // force bypasses the "same cols as last emit" skip; double-fit clears xterm's cached cellWidth.
    const handleOrientationChange = () => setTimeout(() => {
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || term._isDisposed || !fitAddon) return;
      fitAddon.fit();
      fitAddon.fit();
      doResizeRef.current?.({ force: true });
    }, ORIENTATION_SETTLE_MS);
    window.addEventListener("orientationchange", handleOrientationChange);

    // Force redraw when tab becomes visible again (WebGL renderer may not repaint after tab switch)
    const handleVisibilityChange = () => {
      if (!document.hidden && termRef.current) {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("orientationchange", handleOrientationChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      wheelEl.removeEventListener("wheel", handleWheel);
      socket.off("connect", handleReconnect);
      socket.off("output", handleOutput);
      socket.off("cwdChange", handleCwdChange);
      if (scrollDisposeRef.current) scrollDisposeRef.current.dispose();
      term.textarea?.removeEventListener("keyup", maybeFetchHistory);
      if (inputHandlerRef.current) inputHandlerRef.current.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (webglAddonRef.current) webglAddonRef.current.dispose();
      if (writeBatcherRef.current) writeBatcherRef.current.dispose();
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
      setTermReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId]);

  // Live WebGL toggle: swap renderer + re-fit on change (no reload needed)
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !socket || !sessionId) return;
    if (webglEnabled) loadWebGLRef.current?.();
    else disposeWebGLRef.current?.();
  }, [webglEnabled, socket, sessionId]);

  // Live font size: apply + re-fit on change
  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !socket || !sessionId) return;
    if (fontSizeSetting == null) return;
    term.options.fontSize = fontSizeSetting;
    fitAddon.fit();
    emitResize();
    term.refresh(0, term.rows - 1);
  }, [fontSizeSetting, socket, sessionId]);

  // Input handler - only when active
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId) return;

    if (inputHandlerRef.current) {
      inputHandlerRef.current.dispose();
      inputHandlerRef.current = null;
    }

    if (isFocused) {
      inputHandlerRef.current = termRef.current.onData((data) => {
        if (isUserTyping(data)) onInput?.(sessionId);
        socket.emit("input", { sessionId, data });
      });
    }
  }, [isFocused, socket, sessionId, onInput]);

  // Hover scroll: forward mouse-report sequences to PTY even when pane not focused,
  // so alt-screen apps (Claude Code CLI) scroll on hover without stealing keyboard focus.
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId || isFocused) return;
    // Mouse SGR (\x1b[<) or normal (\x1b[M) report → forward; ignore keyboard data
    const isMouseReport = (d) => d.startsWith("\x1b[<") || d.startsWith("\x1b[M");
    const handler = termRef.current.onData((data) => {
      if (isMouseReport(data)) socket.emit("input", { sessionId, data });
    });
    return () => handler.dispose();
  }, [isFocused, socket, sessionId]);

  // Re-fit when becoming visible (desktop: all opened panes; mobile: active pane)
  useEffect(() => {
    if (!isVisible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      // Reconnect fired while this pane was hidden → snapshot was never fetched at the right
      // size. Now visible: reset + rejoin so the daemon serializes at the correct cols.
      if (needsRejoinRef.current) {
        needsRejoinRef.current = false;
        termLog("join", "deferred needsRejoin → fire (pane now visible)");
        termRef.current.reset();
        doJoinSessionRef.current?.(true);
        return;
      }
      // force: pane may have been hidden during reconnect → daemon snapshot stale,
      // and cols/rows unchanged would skip emit → PTY never gets SIGWINCH to redraw.
      doResize({ force: true });
      // Pane was hidden (LRU opacity-0) → force repaint so stale canvas redraws even at same size
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isVisible, doResize]);

  // Refit terminal when pane receives focus (desktop split + mobile active pane)
  // Mobile single-pane: force PTY emit so TUI redraws at the right size (no split size change to trigger it)
  useEffect(() => {
    if (!isFocused) return;
    const mobile = typeof window !== "undefined" && window.innerWidth < 760;
    const timer = setTimeout(() => {
      doResize(mobile ? { force: true } : undefined);
      requestAnimationFrame(() => termRef.current?.refresh(0, termRef.current.rows - 1));
    }, 100);
    return () => clearTimeout(timer);
  }, [isFocused, doResize]);

  // Update theme (app mode + sub-theme)
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolveTerminalTheme(theme, terminalTheme) || THEMES.dark;
    }
  }, [theme, terminalTheme]);

  // Touch scroll with momentum (iOS-like inertia)
  useEffect(() => {
    if (!termReady || !termRef.current) return;

    const xtermScreen = termRef.current.element?.querySelector(".xterm-screen");
    if (!xtermScreen) return;

    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let momentumId = null;
    let accumulated = 0;
    let lastScrollAt = 0;

    const SENSITIVITY = TOUCH_SCROLL.sensitivity;
    const FALLBACK_LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const FRICTION = TOUCH_SCROLL.friction;
    const MIN_VELOCITY = TOUCH_SCROLL.minVelocity;
    const MAX_VELOCITY = TOUCH_SCROLL.maxVelocity;
    const TUI_THROTTLE_MS = TOUCH_SCROLL.tuiThrottleMs;
    const MOMENTUM_CADENCE_MS = TOUCH_SCROLL.momentumRenderCadenceMs;
    const TUI_BACKPRESSURE_TIMEOUT_MS = TOUCH_SCROLL.tuiBackpressureTimeoutMs;
    const MAX_LINES_PER_FRAME = 3; // cap scrollLines per frame → smaller repaints, smoother inertia

    // Throttle SGR wheel burst so touch ≈ PC wheel cadence (TUI decides actual rate).
    let lastSgrAt = 0;
    let pendingLines = 0;
    let pendingTimer = null;
    const flushSgr = () => {
      pendingTimer = null;
      if (!pendingLines) return;
      const t = termRef.current;
      if (!t) { pendingLines = 0; return; }
      const x = Math.max(1, Math.ceil(t.cols / 2));
      const y = Math.max(1, Math.ceil(t.rows / 2));
      const seq = pendingLines > 0 ? TOUCH_SCROLL.sgrDown(x, y) : TOUCH_SCROLL.sgrUp(x, y);
      const n = Math.min(Math.abs(pendingLines), TOUCH_SCROLL.wheelStepLines);
      for (let i = 0; i < n; i++) socket.emit("input", { sessionId, data: seq });
      pendingLines = 0;
      lastSgrAt = performance.now();
      awaitingTuiOutputRef.current = true; // expect output round-trip; cleared in handleOutput
    };

    // Alt-buffer (TUI mouse-tracking) has no scrollback → send SGR wheel to app; else scroll local scrollback
    const applyScroll = (lines) => {
      const t = termRef.current;
      if (!t) return;
      if (t.buffer.active.type === "alternate") {
        // Backpressure: TUI still redrawing last SGR → drop new lines, don't pile up.
        // Safety timeout: clear anyway after TUI_BACKPRESSURE_TIMEOUT_MS so TUIs that
        // don't emit output on wheel (opencode/lazygit) never stall scroll.
        if (awaitingTuiOutputRef.current && performance.now() - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS) return;
        pendingLines += lines;
        const elapsed = performance.now() - lastSgrAt;
        if (elapsed >= TUI_THROTTLE_MS) {
          flushSgr();
        } else if (!pendingTimer) {
          pendingTimer = setTimeout(flushSgr, TUI_THROTTLE_MS - elapsed);
        }
      } else {
        t.scrollLines(Math.max(-MAX_LINES_PER_FRAME, Math.min(MAX_LINES_PER_FRAME, lines)));
        // B3: touch scroll up near top must trigger history fetch — wheel handler sets userAtTopRef,
        // but touch path (applyScroll) never did, so mobile users couldn't load older history.
        if (lines < 0) {
          const buf = t.buffer.active;
          if (buf.viewportY <= HISTORY_FETCH.topThresholdLines) {
            userAtTopRef.current = true;
            maybeFetchHistoryRef.current?.();
          }
        }
      }
    };

    const stopMomentum = () => {
      if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
      velocity = 0;
    };
    stopMomentumRef.current = stopMomentum;

    const doMomentum = () => {
      if (!termRef.current || Math.abs(velocity) < MIN_VELOCITY) {
        momentumId = null;
        return;
      }

      const isAlt = termRef.current.buffer?.active?.type === "alternate";
      const now = performance.now();

      // TUI backpressure (RTT-aware, with timeout safety for non-responsive TUIs)
      const tuiBusy = isAlt && awaitingTuiOutputRef.current && now - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS;
      // Scrollback render cadence: cap repaint to ~30fps during inertia
      const cadenceDue = !isAlt && now - lastScrollAt >= MOMENTUM_CADENCE_MS;

      // Decay at the apply timestep, not per-rAF — otherwise scrollback (apply every 33ms)
      // loses 2x velocity between applies and the glide dies early. TUI always applies → unchanged.
      if (!tuiBusy && (isAlt || cadenceDue)) {
        velocity *= FRICTION;
        accumulated += velocity;
        const lines = Math.trunc(accumulated / LINE_HEIGHT);
        if (lines !== 0) {
          applyScroll(lines);
          accumulated -= lines * LINE_HEIGHT;
          lastScrollAt = performance.now();
        }
      }

      momentumId = requestAnimationFrame(doMomentum);
    };

    // --- Long-press text selection (mobile) ---
    let longPressTimer = null;
    let selecting = false;
    let selStart = null; // {col, row} absolute buffer coords
    let startX = 0, startY = 0, curX = 0, curY = 0, moved = false;

    // Cached during select drag so touchToCell skips getBoundingClientRect() per frame (avoids reflow)
    let selRect = null;

    // Map viewport pixel → absolute buffer cell (accounts for scrollback offset).
    const touchToCell = (clientX, clientY) => {
      const t = termRef.current;
      const rect = selRect || xtermScreen.getBoundingClientRect();
      const cellW = rect.width / t.cols;
      const cellH = rect.height / t.rows;
      const col = Math.max(0, Math.min(t.cols - 1, Math.floor((clientX - rect.left) / cellW)));
      const vRow = Math.max(0, Math.min(t.rows - 1, Math.floor((clientY - rect.top) / cellH)));
      return { col, row: t.buffer.active.viewportY + vRow };
    };

    const selectWordAt = ({ col, row }) => {
      const t = termRef.current;
      const line = t.buffer.active.getLine(row);
      if (!line) return;
      const text = line.translateToString(false);
      const isWord = (c) => c && TOUCH_SELECT.wordChars.test(c);
      if (!isWord(text[col])) { t.select(col, row, 1); return; }
      let start = col, end = col;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length - 1 && isWord(text[end + 1])) end++;
      t.select(start, row, end - start + 1);
    };

    const extendSelection = (cell) => {
      const t = termRef.current;
      if (cell.row === selStart.row) {
        const min = Math.min(cell.col, selStart.col);
        t.select(min, cell.row, Math.abs(cell.col - selStart.col) + 1);
      } else {
        t.selectLines(Math.min(cell.row, selStart.row), Math.max(cell.row, selStart.row));
      }
    };

    const handleTouchStart = (e) => {
      stopMomentum();
      const touch = e.touches[0];
      lastY = touch.clientY;
      startX = curX = touch.clientX;
      startY = curY = touch.clientY;
      lastTime = Date.now();
      velocity = 0;
      accumulated = 0;
      selecting = false;
      moved = false;
      termRef.current?.clearSelection();
      longPressTimer = setTimeout(() => {
        if (moved || !termRef.current) return;
        selecting = true;
        vibrate();
        selRect = xtermScreen.getBoundingClientRect();
        selStart = touchToCell(startX, startY);
        selectWordAt(selStart);
      }, TOUCH_SELECT.longPressMs);
    };

    const handleTouchMove = (e) => {
      if (!termRef.current) return;
      const touch = e.touches[0];
      curX = touch.clientX;
      curY = touch.clientY;

      if (!moved && Math.hypot(curX - startX, curY - startY) > TOUCH_SELECT.moveTolerance) {
        moved = true;
        if (!selecting) clearTimeout(longPressTimer); // it's a scroll, not a long-press
      }

      if (selecting) {
        e.preventDefault();
        extendSelection(touchToCell(curX, curY));
        return;
      }

      const currentY = touch.clientY;
      const currentTime = Date.now();
      const dy = lastY - currentY; // >0 finger up / reveal bottom; <0 finger down / reveal top
      const deltaTime = currentTime - lastTime || 1;

      // Soft-KB: pan outer wrapper first; at edge hand off to xterm scrollback
      const wrap = xtermScreen.closest(".terminal-scroll.is-scrollable");
      if (wrap && wrap.scrollHeight > wrap.clientHeight + 1) {
        const maxScroll = wrap.scrollHeight - wrap.clientHeight;
        const atTop = wrap.scrollTop <= 0.5;
        const atBottom = wrap.scrollTop >= maxScroll - 0.5;
        // Still room in wrapper → scroll it; at top+up or bottom+down → xterm
        const handoffToTerm = (dy < 0 && atTop) || (dy > 0 && atBottom);
        if (!handoffToTerm) {
          if (dy !== 0) {
            e.preventDefault();
            wrap.scrollTop = Math.max(0, Math.min(maxScroll, wrap.scrollTop + dy));
          }
          lastY = currentY;
          lastTime = currentTime;
          velocity = 0;
          accumulated = 0;
          return;
        }
        // fall through to xterm applyScroll
      }

      const deltaY = dy * SENSITIVITY;
      accumulated += deltaY;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        e.preventDefault();
        applyScroll(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity = Math.min((deltaY / deltaTime) * 16, MAX_VELOCITY);
      lastY = currentY;
      lastTime = currentTime;
    };

    const handleTouchEnd = () => {
      clearTimeout(longPressTimer);
      selRect = null;
      if (selecting) {
        selecting = false;
        const sel = termRef.current?.getSelection();
        if (sel && sel.trim()) onSelectionMadeRef.current?.(sel, { x: curX, y: curY });
        return;
      }
      if (Math.abs(velocity) > MIN_VELOCITY) {
        momentumId = requestAnimationFrame(doMomentum);
      }
    };

    xtermScreen.addEventListener("touchstart", handleTouchStart, { passive: true });
    xtermScreen.addEventListener("touchmove", handleTouchMove, { passive: false });
    xtermScreen.addEventListener("touchend", handleTouchEnd, { passive: true });

    // Desktop wheel — when scrolled to top, fetch older history chunk
    const handleWheel = (e) => {
      const t = termRef.current;
      if (!t) return;
      if (e.deltaY < 0 && t.buffer.active.viewportY <= HISTORY_FETCH.topThresholdLines) {
        userAtTopRef.current = true;
        maybeFetchHistoryRef.current?.();
      }
    };
    xtermScreen.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      stopMomentum();
      clearTimeout(longPressTimer);
      xtermScreen.removeEventListener("touchstart", handleTouchStart);
      xtermScreen.removeEventListener("touchmove", handleTouchMove);
      xtermScreen.removeEventListener("touchend", handleTouchEnd);
      xtermScreen.removeEventListener("wheel", handleWheel);
    };
  }, [termReady, isVisible]);

  // Manual per-pane reload: reset local XTerm + re-join THIS session to re-fetch
  // scrollback tail + restore modes, then rebuild WebGL renderer to clear glyph glitch.
  // No socket reconnect, no impact on other panes.
  const reload = useCallback(() => {
    const term = termRef.current;
    if (!term || !socket) return;
    termLog("join", "manual reload (user refetch)");
    term.reset();
    doJoinSessionRef.current?.(true);
    if (webglEnabled) {
      disposeWebGLRef.current?.();
      loadWebGLRef.current?.();
    } else {
      term.refresh(0, term.rows - 1);
    }
  }, [socket, webglEnabled]);

  return {
    termRef,
    cwdRef, // Expose cwd for file path resolution
    cwd, // Reactive cwd for toolbar UI
    searchAddonRef, // Expose for search UI (findNext/findPrevious)
    termReady,
    joining, // true while joinSession round-trip is in flight (initial mount + reconnect)
    doResize,
    reload,
    focus: () => termRef.current?.focus(),
    stopMomentum: () => stopMomentumRef.current?.(),
    historyFetching // true while an older-history chunk is in flight
  };
}
