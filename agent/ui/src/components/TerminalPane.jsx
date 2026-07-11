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
} from "@shared/terminal/index.js";
import { useFileSocket } from "../lib/fileExplorer/useFileSocket";
import { WATCH_DEBOUNCE_MS, MAX_CHANGED_BADGE } from "../lib/fileExplorer/constants";

// Single xterm pane bound local socket — direct protocol (output/input/resize/joinSession).
// Core logic lives in @shared/terminal; this component only wires Preact lifecycle.
export default function TerminalPane({ socket, sessionId, theme = "dark", isFocused, cwd, onActivate, onInput, onOpenFiles, onOpenGit, showFocusBorder, showDoneBorder }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

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

    const unbindOutput = bindOutput(term, socket, sessionId);

    const checkScroll = () => {
      const b = term.buffer.active;
      setShowScrollBtn(b.baseY - b.viewportY > SCROLL_THRESHOLD);
    };
    const scrollDisp = term.onScroll(checkScroll);
    const writeDisp = term.onWriteParsed(checkScroll);

    const doJoin = () => {
      // Fit first so daemon serializes the snapshot at the client's real size (alt-screen TUI wraps by cols)
      doFit();
      socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
      // Reset before replay so serialized snapshot (incl. alt-screen) paints on a clean buffer
      term.reset();
      joinSession(socket, sessionId, {
        onSuccess: () => setTimeout(doFit, 100),
        onError: (msg) => term.write(`\r\n\x1b[1;31mError: ${msg}\x1b[0m\r\n`),
      });
    };
    doJoin();
    if (isFocused) term.focus();

    const unbindReconnect = bindReconnect(term, socket, doJoin);
    const unbindVisibility = bindVisibilityRepaint(term);

    const screen = term.element?.querySelector(".xterm-screen");
    const detachTouch = screen ? attachTouchScroll(term, screen) : () => {};

    return () => {
      ro.disconnect();
      unbindOutput();
      unbindReconnect();
      unbindVisibility();
      detachTouch();
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
  // Done-border shows even while focused (badge persists until input/switch); takes priority over focus glow
  const glow = showDoneBorder ? "terminal-done-border" : (showFocusBorder && isFocused ? "terminal-focus-glow" : "");

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
