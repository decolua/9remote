// test-claude-web/src/components/TerminalView.jsx
// 100% Real PTY Terminal (node-pty + xterm.js) matching 9remote's architecture

import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function TerminalView() {
  const terminalRef = useRef(null);
  const xtermInstance = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: "#070a13",
        foreground: "#f8fafc",
        cursor: "#38bdf8",
        selectionBackground: "rgba(56, 189, 248, 0.3)",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    try { fitAddon.fit(); } catch {}

    xtermInstance.current = term;
    fitAddonRef.current = fitAddon;

    // Connect to real PTY WebSocket (matching 9remote)
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      term.write(e.data);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };

    window.addEventListener("resize", handleResize);
    term.focus();

    return () => {
      window.removeEventListener("resize", handleResize);
      try { ws.close(); } catch {}
      term.dispose();
    };
  }, []);

  return (
    <div
      onClick={() => xtermInstance.current?.focus()}
      className="flex-1 flex flex-col h-full bg-[#070a13] border-l border-white/10 overflow-hidden cursor-text"
    >
      <div className="px-4 py-2 bg-slate-900/90 border-b border-white/10 flex items-center justify-between text-xs text-slate-400 font-mono select-none flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-white font-semibold">Native PTY Terminal (macOS Shell)</span>
        </div>
        <span className="text-[11px] text-slate-400">Tương tác trực tiếp 100% (Phím mũi tên, Tab, zsh/bash)</span>
      </div>
      <div ref={terminalRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  );
}
