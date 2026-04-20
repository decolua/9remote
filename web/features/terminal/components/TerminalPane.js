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
  showFocusBorder = false,
  notifications = {},
  clearNotification,
}) {
  const containerRef = useRef(null);
  const longPressTimer = useRef(null);
  const pasteInputRef = useRef(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [clipboardText, setClipboardText] = useState("");
  const [showScrollButton, setShowScrollButton] = useState(false);

  const { pushView } = useTerminalStore();

  const { termRef, cwdRef, doResize, focus, stopMomentum } = useXTerm({
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

  // Read clipboard if available (secure context + permission granted).
  // Returns empty string on failure so popup still opens with empty input.
  const readClipboardText = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return "";
    }
    try {
      return (await navigator.clipboard.readText()) || "";
    } catch {
      return "";
    }
  };

  const openPastePopup = async () => {
    setPasteText("");
    setShowPasteInput(true);
    setTimeout(() => pasteInputRef.current?.focus(), 100);
    const text = await readClipboardText();
    setClipboardText(text);
  };

  // Long press handlers for paste
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      vibrate();
      openPastePopup();
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const closePastePopup = () => {
    setShowPasteInput(false);
    setPasteText("");
    setClipboardText("");
  };

  const handlePasteButton = () => {
    setPasteText(clipboardText);
    pasteInputRef.current?.focus();
  };

  const sendPasteText = () => {
    if (pasteText && socket) {
      socket.emit("input", { sessionId, data: pasteText });
      vibrate();
    }
    closePastePopup();
  };

  // Track scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    if (!termRef.current || !isVisible) return;

    const term = termRef.current;
    const MIN_SCROLL_THRESHOLD = 5;

    const checkScrollPosition = () => {
      const buffer = term.buffer.active;
      const scrollDistance = buffer.baseY - buffer.viewportY;
      setShowScrollButton(scrollDistance > MIN_SCROLL_THRESHOLD);
    };

    const disposable = term.onScroll(checkScrollPosition);
    const dataDisposable = term.onWriteParsed(checkScrollPosition);

    return () => {
      disposable.dispose();
      dataDisposable.dispose();
    };
  }, [termRef, isVisible]);

  const handleScrollToBottom = () => {
    if (!termRef.current) return;
    vibrate();
    stopMomentum();
    termRef.current.scrollToBottom();
  };

  // Terminal selection - auto open file/URL on selection
  useEffect(() => {
    if (!termRef.current || !isVisible || !socket) return;

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
  }, [termRef, isVisible, socket, sessionId, pushView, cwdRef]);

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
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden p-2 sm:p-4 relative">
        <div
          ref={containerRef}
          className="xterm-screen w-full h-full rounded-sm overflow-hidden"
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchEnd}
        />

        {showScrollButton && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              handleScrollToBottom();
            }}
            className="absolute bottom-5 right-7 z-50 p-2 bg-black/30 hover:bg-black/50 text-white rounded-full border border-white/20 shadow-lg transition-all duration-200 hover:scale-105"
            title="Scroll to bottom"
          >
            <ChevronDown size={20} />
          </button>
        )}
      </div>

      {showPasteInput && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={closePastePopup}
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="bg-dark-500 rounded-brand border border-dark-400 p-4 w-full max-w-md flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={pasteInputRef}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendPasteText();
                if (e.key === "Escape") closePastePopup();
              }}
              placeholder="Paste or type here"
              className="px-4 py-3 bg-dark-600 text-white rounded-brand border border-dark-400 focus:border-brand-500 outline-none w-full"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={closePastePopup}
                className="px-4 py-2 bg-dark-600 hover:bg-dark-400 text-white rounded-brand border border-dark-400 transition-colors"
              >
                Close
              </button>
              {clipboardText && (
                <button
                  onClick={handlePasteButton}
                  className="px-4 py-2 bg-dark-600 hover:bg-dark-400 text-white rounded-brand border border-dark-400 transition-colors"
                >
                  Paste
                </button>
              )}
              <button
                onClick={sendPasteText}
                disabled={!pasteText}
                className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-brand font-medium transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
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
  prev.notifications === next.notifications
));
