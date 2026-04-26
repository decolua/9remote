"use client";

import { useEffect, useRef, memo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { detectSelectionType } from "@/features/terminal/components/SelectionActionButton";
import { parseFilePathWithLine } from "@/features/terminal/utils/linkDetector";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES } from "@/features/terminal/constants/themes";
import { ChevronDown } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { useI18n } from "@/shared/i18n";

// Single terminal pane - XTerm instance only, no header
// isVisible: pane is shown (layout-level)
// isFocused: pane receives keyboard input + shows active border
function TerminalPane({
  socket,
  connected,
  sessionId,
  isVisible,
  isFocused,
  theme = "default",
  onActivate,
  onRegisterApi,
  onPasteFallback,
  showFocusBorder = false,
  notifications = {},
  clearNotification,
}) {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const longPressTimer = useRef(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const { pushView } = useTerminalStore();
  const inputMode = useInputMode();

  const { termRef, cwdRef, termReady, doResize, focus, stopMomentum } = useXTerm({
    socket, sessionId, theme, isVisible, isFocused, containerRef
  });

  // Expose pane API (focus, resize) to parent for MobileKeyboard callbacks
  useEffect(() => {
    if (!onRegisterApi) return;
    onRegisterApi(sessionId, { focus, doResize });
    return () => onRegisterApi(sessionId, null);
  }, [sessionId, focus, doResize, onRegisterApi]);

  // Clear notification when pane becomes visible for this session
  useEffect(() => {
    if (isVisible && sessionId) {
      clearNotification?.(sessionId);
    }
  }, [sessionId, isVisible, clearNotification]);

  const currentTheme = THEMES[theme] || THEMES.default;

  // Long-press: try clipboard paste; if fails/empty → open text input panel below
  const handleLongPressPaste = async () => {
    vibrate();
    let text = "";
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try { text = (await navigator.clipboard.readText()) || ""; } catch { text = ""; }
    }
    if (text && socket) {
      socket.emit("input", { sessionId, data: text });
      return;
    }
    onPasteFallback?.();
  };

  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(handleLongPressPaste, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Track scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    if (!termReady || !termRef.current || !isVisible) return;

    const term = termRef.current;
    const MIN_SCROLL_THRESHOLD = 5;

    const checkScrollPosition = () => {
      const buffer = term.buffer.active;
      const scrollDistance = buffer.baseY - buffer.viewportY;
      setShowScrollButton(scrollDistance > MIN_SCROLL_THRESHOLD);
    };

    checkScrollPosition();
    const disposable = term.onScroll(checkScrollPosition);
    const dataDisposable = term.onWriteParsed(checkScrollPosition);

    return () => {
      disposable.dispose();
      dataDisposable.dispose();
      setShowScrollButton(false);
    };
  }, [termRef, termReady, isVisible]);

  const handleScrollToBottom = () => {
    if (!termRef.current) return;
    vibrate();
    stopMomentum();
    termRef.current.scrollToBottom();
  };

  // Terminal selection - auto open file/URL on selection
  // Only on touch devices (mobile/tablet) where "tap to select" is the natural UX.
  // On desktop/PC, selecting text = copy intent → must NOT auto-open (annoying bug).
  useEffect(() => {
    if (!termRef.current || !isVisible || !socket) return;
    if (inputMode !== "touch") return;

    const term = termRef.current;

    const handleSelectionChange = async () => {
      const selection = term.getSelection();
      if (!selection || selection.trim().length === 0) return;

      const detected = detectSelectionType(selection);

      if (detected.isUrl) {
        term.clearSelection();
        window.open(detected.match, "_blank");
        return;
      }

      if (detected.isFile) {
        const { path, line, column } = parseFilePathWithLine(detected.match);
        term.clearSelection();

        let finalPath = path;
        if (!path.startsWith("/") && cwdRef.current) {
          finalPath = `${cwdRef.current}/${path}`;
        }

        if (termRef.current) termRef.current.focus();
        setTimeout(() => {
          pushView({ type: "editor", path: finalPath, line, column });
        }, 50);
      }
    };

    const disposable = term.onSelectionChange(handleSelectionChange);
    return () => disposable.dispose();
  }, [termRef, isVisible, socket, sessionId, pushView, cwdRef, inputMode]);

  // Click pane → request activation from parent
  const handlePaneClick = () => {
    if (!isFocused) onActivate?.(sessionId);
  };

  // Use ring-inset so focus ring draws inside bounds (symmetric, not clipped by neighbors)
  const borderClass = showFocusBorder && isFocused
    ? "ring-1 ring-inset ring-brand-500/60"
    : "";

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden ${borderClass}`}
      style={{ background: currentTheme.background }}
      onMouseDown={handlePaneClick}
      onTouchStart={(e) => { handlePaneClick(); handleTouchStart(e); }}
    >
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden px-2 sm:p-4 relative">
        <div
          ref={containerRef}
          className="xterm-screen w-full h-full rounded-sm overflow-hidden"
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchEnd}
        />

        {showScrollButton && (
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              handleScrollToBottom();
            }}
            className="absolute bottom-5 right-7 z-50 p-2 bg-black/30 hover:bg-black/50 text-white rounded-full border border-white/20 shadow-lg transition-all duration-200 hover:scale-105"
            title={t("terminalPane.scrollToBottom")}
          >
            <ChevronDown size={20} />
          </button>
        )}
      </div>
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
  prev.notifications === next.notifications
));
