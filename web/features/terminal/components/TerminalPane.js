"use client";

import { useEffect, useRef, memo, useState, useCallback } from "react";
import "@xterm/xterm/css/xterm.css";
import SelectionActionButton from "@/features/terminal/components/SelectionActionButton";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES, resolveTerminalTheme } from "@/features/terminal/constants/themes";
import { ChevronDown, Folder, GitBranch, RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { MAX_CHANGED_BADGE, DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { useGitChangedCount } from "@/features/terminal/hooks/useGitChangedCount";

// Single terminal pane - XTerm instance only, no header
// isVisible: pane is shown (layout-level)
// isFocused: pane receives keyboard input + shows active border
function TerminalPane({
  socket,
  connected,
  sessionId,
  isVisible,
  isFocused,
  onActivate,
  onRegisterApi,
  onPasteFallback,
  showFocusBorder = false,
  notifications = {},
  sessionStatus = {},
  clearNotification,
  fileSocket,
}) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const containerRef = useRef(null);
  const scrollRef = useRef(null);
  const fixedMetaRef = useRef({ width: 0, height: null }); // mobile: lock height vs soft-KB shrink
  const [fixedHeight, setFixedHeight] = useState(null);
  const [kbShrunk, setKbShrunk] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState(null); // { text, x, y } from long-press select

  const { pushView } = useTerminalStore();
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);

// Scroll wrapper so the cursor/content stays visible after a viewport shrink (soft KB).
// Short content pinned to top; long content scrolls the cursor row into the visible rect.
  const scrollCursorIntoView = useCallback(() => {
    const el = scrollRef.current;
    const term = termRef.current;
    if (!el || !term) return;
    const fixedH = fixedMetaRef.current.height;
    if (fixedH == null || el.clientHeight >= fixedH - 1) return; // nothing clipped
    const buffer = term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY; // absolute row of the prompt/cursor
    const cellH = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect()?.height
      ? (term.element.querySelector(".xterm-screen").getBoundingClientRect().height / term.rows)
      : 0;
    if (cellH <= 0) { el.scrollTop = el.scrollHeight; return; }
    const cursorY = cursorRow * cellH;
    const visibleH = el.clientHeight;
    // Content shorter than viewport → keep at top (prompt visible), else center cursor in visible rect
    const contentH = (buffer.baseY + term.rows) * cellH;
    if (contentH <= fixedH) {
      el.scrollTop = 0;
      return;
    }
    const target = Math.max(0, Math.min(cursorY - visibleH + cellH * 2, el.scrollHeight - el.clientHeight));
    el.scrollTop = target;
  }, []);

  // Mobile only: lock terminal height to max (keyboard-closed) size; parent scrolls when --app-height shrinks
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastViewportH = 0; // detect shrink edge only — don't re-pin scroll every RO jitter

    const update = () => {
      if (window.innerWidth >= DESKTOP_BREAKPOINT) {
        fixedMetaRef.current = { width: 0, height: null };
        lastViewportH = 0;
        setFixedHeight(null);
        setKbShrunk(false);
        return;
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (h <= 0) return;
      const prev = fixedMetaRef.current;
      // Width change (rotate) → re-lock. Soft KB: width same, height down → keep larger height.
      // >= prev-2: KB closing returns height to (near) stored max → clear shrink state.
      // Tolerance 2px < shrink threshold 8px, so real shrinks still fall through to else-if.
      if (w !== prev.width || prev.height == null || h >= prev.height - 2) {
        fixedMetaRef.current = { width: w, height: h };
        setFixedHeight(h);
        lastViewportH = h;
        setKbShrunk(false);
      } else if (prev.height != null && h < prev.height && h < lastViewportH - 8) {
        // Viewport just shrunk (soft KB open) — bring cursor/prompt into the visible rect (once)
        lastViewportH = h;
        setKbShrunk(true);
        requestAnimationFrame(scrollCursorIntoView);
      } else {
        lastViewportH = h;
      }
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("orientationchange", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", update);
    };
  }, [scrollCursorIntoView]);

  const { termRef, cwdRef, cwd, termReady, doResize, reload, focus, stopMomentum, historyFetching } = useXTerm({
    socket, sessionId, theme, terminalTheme, isVisible, isFocused, containerRef,
    onInput: clearNotification,
    onSelectionMade: (text, pos) => setSelection({ text, x: pos.x, y: pos.y }),
  });

  // Expose pane API (focus, resize) to parent for MobileKeyboard callbacks
  useEffect(() => {
    if (!onRegisterApi) return;
    onRegisterApi(sessionId, { focus, doResize });
    return () => onRegisterApi(sessionId, null);
  }, [sessionId, focus, doResize, onRegisterApi]);

  const currentTheme = resolveTerminalTheme(theme, terminalTheme) || THEMES.dark;

  // Long-press: try clipboard paste; if fails/empty → open text input panel below
  const handleLongPressPaste = async () => {
    vibrate();
    let text = "";
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try { text = (await navigator.clipboard.readText()) || ""; } catch { text = ""; }
    }
    if (text && socket) {
      clearNotification?.(sessionId);
      socket.emit("input", { sessionId, data: text });
      return;
    }
    onPasteFallback?.();
  };

  // Track scroll position to show/hide scroll-to-bottom button
  // Mobile soft-KB: wrapper scrolls fixed pane → use wrapper offset. Else xterm scrollback.
  useEffect(() => {
    if (!termReady || !termRef.current || !isVisible) return;

    const term = termRef.current;
    const MIN_SCROLL_THRESHOLD = 5;

    const checkScrollPosition = () => {
      const el = scrollRef.current;
      const wrapScrolled = el?.classList.contains("is-scrollable") && el.scrollHeight > el.clientHeight + 1
        ? (el.scrollHeight - el.clientHeight - el.scrollTop > MIN_SCROLL_THRESHOLD)
        : false;
      const buffer = term.buffer.active;
      const termScrolled = buffer.baseY - buffer.viewportY > MIN_SCROLL_THRESHOLD;
      // Show when EITHER scroll layer is not at the bottom (KB wrapper pane, or xterm scrollback)
      setShowScrollButton(wrapScrolled || termScrolled);
    };

    // Coalesce rapid writes into one check per frame (avoids re-render storm on heavy output)
    let rafId = null;
    const checkScrollPositionRaf = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = null; checkScrollPosition(); });
    };

    checkScrollPosition();
    const disposable = term.onScroll(checkScrollPositionRaf);
    const dataDisposable = term.onWriteParsed(checkScrollPositionRaf);
    const onWrapScroll = () => checkScrollPositionRaf();
    scrollRef.current?.addEventListener("scroll", onWrapScroll, { passive: true });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      disposable.dispose();
      dataDisposable.dispose();
      scrollRef.current?.removeEventListener("scroll", onWrapScroll);
      setShowScrollButton(false);
    };
  }, [termRef, termReady, isVisible]);

  // Shared, ref-counted git changed-count per cwd — syncs across panes, polls every 10s
  const changedCount = useGitChangedCount(cwd, fileSocket, { enabled: isVisible });

  const badgeLabel = changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount;

  const handleScrollToBottom = () => {
    vibrate();
    stopMomentum();
    const el = scrollRef.current;
    if (el?.classList.contains("is-scrollable") && el.scrollHeight > el.clientHeight + 1) {
      el.scrollTop = el.scrollHeight;
    }
    termRef.current?.scrollToBottom();
  };

  // Click pane → request activation from parent
  const handlePaneClick = () => {
    if (!isFocused) onActivate?.(sessionId);
  };

  // Status border now lives on the pane WRAPPER (layout.js), not this inner node.
  const focusClass = [
    showFocusBorder && isFocused ? "terminal-focus-glow" : ""
  ].filter(Boolean).join(" ");

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden relative touch-none ${focusClass}`}
      style={{ background: currentTheme.background }}
      onMouseDown={handlePaneClick}
      onTouchStart={() => handlePaneClick()}
    >
      {/* Mobile: scroll wrapper; terminal keeps fixed (keyboard-closed) height so PTY size stays put */}
      <div
        ref={scrollRef}
        className={`terminal-wrapper terminal-scroll flex-1 min-h-0 relative${kbShrunk ? " is-scrollable" : ""}`}
      >
        <div
          ref={containerRef}
          className="xterm-screen w-full rounded-sm overflow-hidden px-1.5 py-1.5"
          style={fixedHeight != null
            ? { height: fixedHeight, minHeight: fixedHeight }
            : { height: "100%", minHeight: "100%" }}
        />

        {historyFetching && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-2/80 backdrop-blur-sm shadow-md text-xs text-text-secondary">
              <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              Loading history…
            </div>
          </div>
        )}

        {selection && (
          <SelectionActionButton
            text={selection.text}
            position={selection}
            onOpenFile={(path, line, column) => {
              let finalPath = path;
              if (!path.startsWith("/") && cwdRef.current) {
                finalPath = `${cwdRef.current}/${path}`;
              }
              focus();
              pushView({ type: "editor", path: finalPath, line, column });
            }}
            onOpenUrl={(url) => window.open(url, "_blank")}
            onCopy={(txt) => { try { navigator.clipboard?.writeText(txt); } catch {} }}
            onClose={() => { termRef.current?.clearSelection(); setSelection(null); }}
          />
        )}
      </div>

      {/* Overlays stay on viewport, not inside scroll content */}
      {cwd && isFocused && (
        <div className="absolute top-2 right-2 z-50 flex flex-col gap-2 pointer-events-auto touch-none">
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              if (refreshing) return;
              vibrate();
              setRefreshing(true);
              reload();
              setTimeout(() => setRefreshing(false), 700);
            }}
            className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
            title={t("terminalPane.refresh")}
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); vibrate(); pushView({ type: "files", workspace: cwd, currentPath: cwd }); }}
            className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
            title={t("terminalPane.openFolder")}
          >
            <Folder size={16} />
          </button>
          {changedCount > 0 && (
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); pushView({ type: "git", workspace: cwd }); }}
              className="relative p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.changedFiles")}
            >
              <GitBranch size={16} />
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                {badgeLabel}
              </span>
            </button>
          )}
        </div>
      )}

      {showScrollButton && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            handleScrollToBottom();
          }}
          className="absolute bottom-5 right-7 z-50 p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94] touch-none"
          title={t("terminalPane.scrollToBottom")}
        >
          <ChevronDown size={20} />
        </button>
      )}
    </div>
  );
}

export default memo(TerminalPane, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.isVisible === next.isVisible &&
  prev.isFocused === next.isFocused &&
  prev.connected === next.connected &&
  prev.theme === next.theme &&
  prev.showFocusBorder === next.showFocusBorder &&
  prev.notifications === next.notifications &&
  prev.sessionStatus === next.sessionStatus
));
