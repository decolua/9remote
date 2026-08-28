"use client";

import { useEffect, useRef, memo, useState, useCallback } from "react";
import "@xterm/xterm/css/xterm.css";
import SelectionActionButton from "@/features/terminal/components/SelectionActionButton";
import { useGitChangedCount } from "@/features/terminal/hooks/useGitChangedCount";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES, resolveTerminalTheme } from "@/features/terminal/constants/themes";
import { ChevronDown, Folder, RefreshCw, ListChecks, Sparkles } from "@/shared/components/ui/Icon";
import NotePanel from "@/features/terminal/components/NotePanel";
import PaneStripButtons from "@/features/terminal/components/PaneStripButtons";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { dotClassName, statusVisual } from "@/shared/utils/statusVisual";
import { STATUS_BAR_HEIGHT } from "@/shared/constants/layout";
import { MAX_CHANGED_BADGE, DESKTOP_BREAKPOINT, TERMINAL_BG_ALPHA, TERMINAL_BG_VEIL_RGB, TERMINAL_BG_LIFT_RGB, TERMINAL_BG_LIFT, backgroundSrc, paneBackgroundKey, resolvableBackgroundKeys } from "@/features/terminal/constants/terminalConfig";

// Single terminal pane - XTerm instance only, no header
// isVisible: pane is shown (layout-level)
// isFocused: pane receives keyboard input + shows active border
function TerminalPane({
  socket,
  workspacePath,
  connected,
  sessionId,
  sessionName,
  sessionState = "idle",
  isVisible,
  isFocused,
  mountDelay = 0,
  onActivate,
  onRegisterApi,
  onPasteFallback,
  showFocusBorder = false,
  clearNotification,
  fileSocket,
  bgIndex = 0,
  onOpenArtifact,
  onOpenRemote,
  onOpenMobile,
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

  const setRightPanelTab = useTerminalStore((s) => s.setRightPanelTab);
  const openRightPanel = useTerminalStore((s) => s.openRightPanel);
  const setRightPanelRoot = useTerminalStore((s) => s.setRightPanelRoot);
  const paneCwd = useTerminalStore((s) => s.cwdBySession[sessionId]);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const paneBgKey = paneBackgroundKey(resolvableBackgroundKeys(terminalBackgrounds, customBackgrounds), bgIndex);
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const showNoteButton = useTerminalStore((s) => s.showNoteButton);
  // What the AI has shown from this terminal, newest first. Only this pane's stack —
  // another terminal's artifacts are its own to reopen.
  const artifacts = useTerminalStore((s) => s.artifactsBySession[sessionId]);
  const notePinned = useTerminalStore((s) => !!s.pinnedNotes?.[sessionId]);
  const setNotePinned = useTerminalStore((s) => s.setNotePinned);

  const showPinnedNote = notePinned && showNoteButton;
  const showTitleStrip = !showPinnedNote;

  // The modal is transient local state; the pinned strip is persisted per session so a
  // remounted pane (LRU eviction, reload) comes back with it.
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteAppend, setNoteAppend] = useState(null);

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

  // Mobile-only background image on the pane: veil + screen-lift layers dim it, the
  // xterm canvas above stays fully transparent so padding can't create a bright frame
  const bgSrc = backgroundSrc(paneBgKey, customBackgrounds);
  const bgActive = !!bgSrc && theme === "dark" && typeof window !== "undefined" && window.innerWidth < DESKTOP_BREAKPOINT;

  const stripButtons = <PaneStripButtons onOpenRemote={onOpenRemote} onOpenMobile={onOpenMobile} />;

  const { termRef, cwdRef, cwd, termReady, joining, doResize, reload, focus, stopMomentum, historyFetching } = useXTerm({
    // Effective key — the canvas goes transparent only when the image actually renders,
    // so a pool key without a resolvable item (deleted/raced) falls back to opaque, not black
    socket, sessionId, theme, terminalTheme, isVisible, isFocused, containerRef, mountDelay, bgKey: bgActive ? paneBgKey : "none",
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

  // Each pane counts its own cwd; the hook shares one poll per unique cwd across panes.
  const shownCount = useGitChangedCount(cwd, fileSocket, { enabled: isVisible });

  const badgeLabel = shownCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : shownCount;

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

  const veil = `rgba(${TERMINAL_BG_VEIL_RGB},${terminalBackgroundOpacity ?? TERMINAL_BG_ALPHA})`;
  const lift = `rgba(${TERMINAL_BG_LIFT_RGB},${TERMINAL_BG_LIFT})`;

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden relative touch-none px-1.5 py-1.5 ${focusClass}${bgActive ? " terminal-has-bg" : ""}`}
      style={bgActive ? {
        background: `linear-gradient(${veil},${veil}), linear-gradient(${lift},${lift}), center / cover no-repeat url("${bgSrc}")`,
        backgroundBlendMode: "normal, screen, normal"
      } : { background: currentTheme.background }}
      onMouseDown={handlePaneClick}
      onTouchStart={() => handlePaneClick()}
    >
      {/* Mobile has no tab strip in view once a pane is open, so the terminal names itself
          here. A pinned checklist says more than a name, so it takes the slot instead. */}
      {showTitleStrip && (
        <div
          style={{ height: STATUS_BAR_HEIGHT }}
          className="sm:hidden flex items-center gap-2 px-2 -mt-1.5 -mx-1.5 mb-1.5 flex-shrink-0 bg-surface border-b border-border-subtle text-[11px] select-none relative z-10"
        >
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClassName(sessionState)}`} style={{ background: statusVisual(sessionState).dot }} />
          <span className="flex-1 min-w-0 truncate text-text">{sessionName || t("terminal.defaultName")}</span>
          {stripButtons}
        </div>
      )}

      {/* Pinned checklist sits in flow above the terminal, like the bottom status bar */}
      {showPinnedNote && (
        <NotePanel
          socket={socket}
          sessionId={sessionId}
          variant="pinned"
          rightSlot={stripButtons}
        />
      )}

      {/* Mobile: scroll wrapper; terminal keeps fixed (keyboard-closed) height so PTY size stays put */}
      <div
        ref={scrollRef}
        className={`terminal-wrapper terminal-scroll flex-1 min-h-0 relative ${kbShrunk ? " is-scrollable" : ""}`}
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
            onAddToNote={(txt) => { setSelection(null); setNoteAppend(txt); setNoteModalOpen(true); }}
            onClose={() => { termRef.current?.clearSelection(); setSelection(null); }}
          />
        )}

      </div>

      {/* Overlays stay on viewport, not inside scroll content */}
      {showScrollButton && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => {
            e.stopPropagation();
            handleScrollToBottom();
          }}
          className="absolute bottom-3 right-5 z-10 p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94] touch-none"
          title={t("terminalPane.scrollToBottom")}
        >
          <ChevronDown size={20} />
        </button>
      )}
      {cwd && isFocused && (
        <div className={`absolute right-2 z-10 flex flex-col items-end gap-2 pointer-events-auto touch-none ${showPinnedNote ? "top-9" : "top-9 sm:top-2"}`}>
          <div className="flex flex-row gap-2">
            {showNoteButton && (
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); vibrate(); setNoteAppend(null); setNoteModalOpen(true); }}
                className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
                title={t("terminalPane.note")}
              >
                <ListChecks size={16} />
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
              onClick={(e) => {
                e.stopPropagation(); vibrate();
                // Reveal where this terminal stands (OSC 7), not its fixed workspace root
                setRightPanelRoot(workspacePath, paneCwd || workspacePath);
                // Desktop jumps to files; mobile keeps the workspace's saved tab
                if (window.innerWidth >= DESKTOP_BREAKPOINT) setRightPanelTab("files", workspacePath);
                else openRightPanel();
              }}
              className="relative p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.openFolderHere")}
            >
              <Folder size={16} />
              {shownCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                  {badgeLabel}
                </span>
              )}
            </button>
          )}
          {/* Reopen what the AI showed here. Hiding the app closes the panel but not the
              stack, so this is the way back to it. */}
          {onOpenArtifact && artifacts?.length > 0 && (
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); onOpenArtifact(sessionId, artifacts[0]); }}
              className="relative p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.artifacts")}
            >
              <Sparkles size={16} />
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                {artifacts.length}
              </span>
            </button>
          )}
        </div>
      )}

      {noteModalOpen && showNoteButton && (
        <NotePanel
          socket={socket}
          sessionId={sessionId}
          appendOnOpen={noteAppend}
          pinned={notePinned}
          onPin={(next) => setNotePinned(sessionId, next)}
          onClose={() => { setNoteModalOpen(false); setNoteAppend(null); }}
        />
      )}
    </div>
  );
}

export default memo(TerminalPane, (prev, next) => (
  prev.sessionId === next.sessionId &&
  prev.isVisible === next.isVisible &&
  prev.isFocused === next.isFocused &&
  prev.bgIndex === next.bgIndex &&
  prev.connected === next.connected &&
  prev.showFocusBorder === next.showFocusBorder &&
  // The mobile title strip reads both, so a rename or a status change must repaint.
  prev.sessionName === next.sessionName &&
  prev.sessionState === next.sessionState &&
  // Not decoration: it closes over the workspace an artifact opens against, so a stale
  // one would open the file under the wrong root.
  prev.onOpenArtifact === next.onOpenArtifact
));
