"use client";

import { useEffect, useRef, memo, useState, useCallback } from "react";
import "@xterm/xterm/css/xterm.css";
import SelectionActionButton from "@/features/terminal/components/SelectionActionButton";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES, resolveTerminalTheme } from "@/features/terminal/constants/themes";
import { ChevronDown, Folder, GitBranch, RefreshCw, SquarePen, MessageSquare, Terminal as TerminalIcon } from "@/shared/components/ui/Icon";
import NotePanel from "@/features/terminal/components/NotePanel";
import AgentChatPane from "@/features/agentChat/components/AgentChatPane";
import { useAgentChat } from "@/features/agentChat/hooks/useAgentChat";
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
  mountDelay = 0,
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
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const showGitButton = useTerminalStore((s) => s.showGitButton);
  const showNoteButton = useTerminalStore((s) => s.showNoteButton);

  // Note overlay state: open + optional text to append (from selection menu)
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteAppend, setNoteAppend] = useState(null);

  // Chat GUI: a second view of THIS pty. Subscribing while in terminal mode is what
  // makes the toggle appear and its dot light up when the CLI blocks on a prompt.
  const [guiMode, setGuiMode] = useState(false);
  const { hasAgent, prompt: agentPrompt } = useAgentChat(socket, sessionId, { enabled: isVisible });

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

  // In GUI mode the terminal is covered. It still has a layout box (hidden with
  // `invisible`, not `display:none`) so its size never collapses — but a resize the user
  // cannot see is a one-way change no one can sanity-check, so treat the pane as hidden.
  const termVisible = isVisible && !guiMode;

  const { termRef, cwdRef, cwd, termReady, joining, doResize, reload, focus, stopMomentum, historyFetching } = useXTerm({
    socket, sessionId, theme, terminalTheme, isVisible: termVisible, isFocused: isFocused && !guiMode, containerRef, mountDelay,
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

  // Long-press: open text input panel — user pastes via native paste menu there.
  // Avoids navigator.clipboard.readText() (triggers a clipboard-read permission prompt).
  const handleLongPressPaste = () => {
    vibrate();
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
      className={`h-full w-full flex flex-col overflow-hidden relative touch-none px-1.5 py-1.5 ${focusClass}`}
      style={{ background: currentTheme.background }}
      onMouseDown={handlePaneClick}
      onTouchStart={() => handlePaneClick()}
    >
      {/* Mobile: scroll wrapper; terminal keeps fixed (keyboard-closed) height so PTY size stays put */}
      <div
        ref={scrollRef}
        className={`terminal-wrapper terminal-scroll flex-1 min-h-0 relative ${kbShrunk ? " is-scrollable" : ""}${guiMode ? " invisible pointer-events-none" : ""}`}
      >
        <div
          ref={containerRef}
          className="xterm-screen w-full rounded-sm overflow-hidden"
          style={fixedHeight != null
            ? { height: fixedHeight, minHeight: fixedHeight }
            : { height: "100%", minHeight: "100%" }}
        />

        {/* Center loading spinner during initial join / reconnect (before scrollback paints). */}
        {(joining || !termReady) && (
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
            <span className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

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
            onOpenUrl={(url) => window.open(url, "_blank")}
            onCopy={(txt) => { try { navigator.clipboard?.writeText(txt); } catch {} }}
            onAddToNote={(txt) => { setSelection(null); setNoteAppend(txt); setNoteOpen(true); }}
            onClose={() => { termRef.current?.clearSelection(); setSelection(null); }}
          />
        )}

      </div>

      {/* Chat GUI covers the terminal but shares its pty — inset matches the pane padding */}
      {guiMode && (
        <AgentChatPane
          socket={socket}
          sessionId={sessionId}
          isVisible={isVisible}
          getTerm={() => termRef.current}
          onOpenFile={(filePath) => pushView({ type: "files", workspace: cwd, currentPath: filePath, fromTerminal: true })}
          className="absolute inset-1.5 z-30"
        />
      )}

      {/* Overlays stay on viewport, not inside scroll content */}
      {showScrollButton && !guiMode && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            handleScrollToBottom();
          }}
          className="absolute bottom-3 right-5 z-50 p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94] touch-none"
          title={t("terminalPane.scrollToBottom")}
        >
          <ChevronDown size={20} />
        </button>
      )}
      {/* Toggle lives per-pane, not in the header: a split desktop layout has two panes
          and one header, so each pane needs its own switch. Offered on every pane —
          screen mode works with no hooks and no transcript, just the pane's own output. */}
      {isFocused && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); vibrate(); setGuiMode((v) => !v); }}
          className="absolute top-2 left-2 z-50 p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
          title={guiMode ? t("terminalPane.agentChatShowTerminal") : t("terminalPane.agentChatShowChat")}
        >
          <span className="relative block">
            {guiMode ? <TerminalIcon size={16} /> : <MessageSquare size={16} />}
            {!guiMode && agentPrompt && (
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-brand-500 animate-pulse-glow" />
            )}
          </span>
        </button>
      )}

      {cwd && isFocused && !guiMode && (
        <div className="absolute top-2 right-2 z-50 flex flex-col items-end gap-2 pointer-events-auto touch-none">
          <div className="flex flex-row gap-2">
            {showNoteButton && (
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); vibrate(); setNoteAppend(null); setNoteOpen(true); }}
                className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
                title={t("terminalPane.note")}
              >
                <SquarePen size={16} />
              </button>
            )}
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
          </div>
          {showFolderButton && (
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); pushView({ type: "files", workspace: cwd, currentPath: cwd, fromTerminal: true }); }}
              className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.openFolder")}
            >
              <Folder size={16} />
            </button>
          )}
          {showGitButton && changedCount > 0 && (
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

      {noteOpen && showNoteButton && (
        <NotePanel
          socket={socket}
          sessionId={sessionId}
          appendOnOpen={noteAppend}
          onClose={() => { setNoteOpen(false); setNoteAppend(null); }}
        />
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
