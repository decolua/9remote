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
} from "@shared/terminal/index.js";

// Single xterm pane bound local socket — direct protocol (output/input/resize/joinSession).
// Core logic lives in @shared/terminal; this component only wires Preact lifecycle.
export default function TerminalPane({ socket, sessionId, theme = "dark", isFocused, onActivate, showFocusBorder }) {
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
    const handler = termRef.current.onData((data) => socket.emit("input", { sessionId, data }));
    return () => handler.dispose();
  }, [isFocused, socket, sessionId]);

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
  const glow = showFocusBorder && isFocused ? "terminal-focus-glow" : "";

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden relative ${glow}`}
      style={{ background: resolveTheme(theme).background }}
      onMouseDown={() => { if (!isFocused) onActivate?.(sessionId); }}
    >
      <div className="terminal-wrapper flex-1 min-h-0 overflow-hidden px-1 py-0.5 relative">
        <div ref={containerRef} className="w-full h-full" />
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
