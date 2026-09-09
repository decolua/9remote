// test-claude-web/src/components/TerminalView.jsx
// Dual Terminal View: Claude CLI Process (ANSI Stream) + Native PTY Shell

import React, { useState, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function TerminalView({ ansiStream = [] }) {
  const [tab, setTab] = useState("claude"); // 'claude' | 'pty'

  // Ref for Claude ANSI Terminal
  const claudeTermRef = useRef(null);
  const claudeXterm = useRef(null);
  const claudeFit = useRef(null);
  const lastRenderedChunk = useRef(0);

  // Ref for PTY Shell Terminal
  const ptyTermRef = useRef(null);
  const ptyXterm = useRef(null);
  const ptyFit = useRef(null);
  const wsRef = useRef(null);

  // 1. Initialize Claude Process ANSI Terminal
  useEffect(() => {
    if (!claudeTermRef.current || claudeXterm.current) return;

    const term = new Terminal({
      cursorBlink: false,
      fontFamily: 'ui-monospace, "Fira Code", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.4,
      convertEol: true,
      theme: {
        background: "#070a13",
        foreground: "#f8fafc",
        cursor: "#a855f7",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(claudeTermRef.current);
    try { fitAddon.fit(); } catch {}

    claudeXterm.current = term;
    claudeFit.current = fitAddon;

    // Catch up existing chunks
    for (const chunk of ansiStream) {
      term.write(chunk);
    }
    lastRenderedChunk.current = ansiStream.length;
  }, []);

  // Write new chunks to Claude ANSI Terminal
  useEffect(() => {
    if (!claudeXterm.current) return;
    const newChunks = ansiStream.slice(lastRenderedChunk.current);
    for (const chunk of newChunks) {
      claudeXterm.current.write(chunk);
    }
    lastRenderedChunk.current = ansiStream.length;
  }, [ansiStream]);

  // 2. Initialize PTY Shell Terminal
  useEffect(() => {
    if (!ptyTermRef.current || ptyXterm.current) return;

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
    term.open(ptyTermRef.current);
    try { fitAddon.fit(); } catch {}

    ptyXterm.current = term;
    ptyFit.current = fitAddon;

    // Connect to real PTY WebSocket
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

    return () => {
      window.removeEventListener("resize", handleResize);
      try { ws.close(); } catch {}
      term.dispose();
      ptyXterm.current = null;
    };
  }, []);

  // Re-fit when switching tabs or window resize
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (tab === "claude") claudeFit.current?.fit();
        if (tab === "pty") {
          ptyFit.current?.fit();
          ptyXterm.current?.focus();
        }
      } catch {}
    }, 50);
    return () => clearTimeout(timer);
  }, [tab]);

  const handleClearClaudeTerm = () => {
    claudeXterm.current?.clear();
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#070a13] border-l border-white/10 overflow-hidden">
      {/* Tab Switcher Header */}
      <div className="px-4 py-1.5 bg-slate-900/90 border-b border-white/10 flex items-center justify-between text-xs font-mono select-none flex-shrink-0">
        <div className="flex items-center gap-1 bg-black/40 p-0.5 rounded-lg border border-white/10">
          <button
            onClick={() => setTab("claude")}
            className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${
              tab === "claude"
                ? "bg-purple-600/80 text-white shadow-sm shadow-purple-500/30"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <span>🤖</span>
            <span>Luồng Claude CLI</span>
          </button>
          <button
            onClick={() => setTab("pty")}
            className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${
              tab === "pty"
                ? "bg-blue-600 text-white shadow-sm shadow-blue-500/30"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <span>💻</span>
            <span>Shell PTY</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {tab === "claude" && (
            <button
              onClick={handleClearClaudeTerm}
              className="text-slate-500 hover:text-slate-300 text-[11px] px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
            >
              Xóa log
            </button>
          )}
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            {tab === "claude" ? "ANSI stream trực tiếp" : "Tương tác 100% zsh/bash"}
          </span>
        </div>
      </div>

      {/* Terminal Displays */}
      <div className="flex-1 relative overflow-hidden p-2">
        {/* Claude ANSI Terminal */}
        <div
          ref={claudeTermRef}
          className={`absolute inset-2 overflow-hidden ${tab === "claude" ? "block" : "hidden"}`}
        />

        {/* PTY Interactive Terminal */}
        <div
          ref={ptyTermRef}
          onClick={() => ptyXterm.current?.focus()}
          className={`absolute inset-2 overflow-hidden cursor-text ${tab === "pty" ? "block" : "hidden"}`}
        />
      </div>
    </div>
  );
}
