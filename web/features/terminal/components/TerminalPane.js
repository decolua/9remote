"use client";

import { useEffect, useRef, memo, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import SelectionActionButton from "@/features/terminal/components/SelectionActionButton";
import { useXTerm } from "@/features/terminal/hooks/useXTerm";
import { THEMES } from "@/features/terminal/constants/themes";
import { ChevronDown, Folder, GitBranch } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { WATCH_DEBOUNCE_MS, MAX_CHANGED_BADGE } from "@/features/terminal/constants/terminalConfig";

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
  clearNotification,
  fileSocket,
}) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const containerRef = useRef(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [selection, setSelection] = useState(null); // { text, x, y } from long-press select
  const [changedCount, setChangedCount] = useState(0);

  const { pushView } = useTerminalStore();

  const { termRef, cwdRef, cwd, termReady, doResize, focus, stopMomentum } = useXTerm({
    socket, sessionId, theme, isVisible, isFocused, containerRef,
    onInput: clearNotification,
    onSelectionMade: (text, pos) => setSelection({ text, x: pos.x, y: pos.y }),
  });

  // Expose pane API (focus, resize) to parent for MobileKeyboard callbacks
  useEffect(() => {
    if (!onRegisterApi) return;
    onRegisterApi(sessionId, { focus, doResize });
    return () => onRegisterApi(sessionId, null);
  }, [sessionId, focus, doResize, onRegisterApi]);

  const currentTheme = THEMES[theme] || THEMES.dark;

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
  useEffect(() => {
    if (!termReady || !termRef.current || !isVisible) return;

    const term = termRef.current;
    const MIN_SCROLL_THRESHOLD = 5;

    const checkScrollPosition = () => {
      const buffer = term.buffer.active;
      const scrollDistance = buffer.baseY - buffer.viewportY;
      setShowScrollButton(scrollDistance > MIN_SCROLL_THRESHOLD);
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

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      disposable.dispose();
      dataDisposable.dispose();
      setShowScrollButton(false);
    };
  }, [termRef, termReady, isVisible]);

  // Watch cwd + track changed-files count via git status (debounced on fs events)
  useEffect(() => {
    if (!cwd || !fileSocket || !socket) return;
    let timer = null;
    // Keep last count on transient failures (reconnect/not-a-repo race); only update on success
    const refresh = async () => {
      const res = await fileSocket.gitChangedCount(cwd);
      if (res?.success) setChangedCount(res.count || 0);
    };
    const onFileChange = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, WATCH_DEBOUNCE_MS);
    };
    fileSocket.watchDir(cwd);
    socket.on("fileChange", onFileChange);
    refresh();
    return () => {
      clearTimeout(timer);
      socket.off("fileChange", onFileChange);
      fileSocket.unwatchDir(cwd);
    };
  }, [cwd, fileSocket, socket]);

  const badgeLabel = changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount;

  const handleScrollToBottom = () => {
    if (!termRef.current) return;
    vibrate();
    stopMomentum();
    termRef.current.scrollToBottom();
  };

  // Click pane → request activation from parent
  const handlePaneClick = () => {
    if (!isFocused) onActivate?.(sessionId);
  };

  // Done-border shows even while focused (badge persists until input/switch); takes priority over focus glow
  const focusClass = notifications[sessionId]
    ? "terminal-done-border"
    : (showFocusBorder && isFocused ? "terminal-focus-glow" : "");

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden relative ${focusClass}`}
      style={{ background: currentTheme.background }}
      onMouseDown={handlePaneClick}
      onTouchStart={() => handlePaneClick()}
    >
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden relative">
        <div
          ref={containerRef}
          className="xterm-screen w-full h-full rounded-sm overflow-hidden px-1 py-0.5 "
        />

        {cwd && isFocused && changedCount > 0 && (
          <div className="absolute top-2 right-2 z-50 flex flex-col gap-2">
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); pushView({ type: "files", workspace: cwd, currentPath: cwd }); }}
              className="p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.openFolder")}
            >
              <Folder size={16} />
            </button>
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); pushView({ type: "git", workspace: cwd }); }}
              className="relative p-2 bg-surface-2/60 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
              title={t("terminalPane.changedFiles")}
            >
              <GitBranch size={16} />
              {changedCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                  {badgeLabel}
                </span>
              )}
            </button>
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

        {showScrollButton && (
          <button
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.stopPropagation();
              handleScrollToBottom();
            }}
            className="absolute bottom-5 right-7 z-50 p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-full shadow-md transition-all duration-150 ease-out active:scale-[0.94]"
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
