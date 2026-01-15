"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import SitesList from "./SitesList";

// Terminal color themes
const THEMES = {
  slate: {
    background: "#0f172a", foreground: "#e2e8f0", cursor: "#3b82f6",
    black: "#1e293b", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
    blue: "#3b82f6", magenta: "#a855f7", cyan: "#06b6d4", white: "#cbd5e1",
    brightBlack: "#475569", brightRed: "#f87171", brightGreen: "#4ade80",
    brightYellow: "#facc15", brightBlue: "#60a5fa", brightMagenta: "#c084fc",
    brightCyan: "#22d3ee", brightWhite: "#f1f5f9"
  },
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff"
  },
  monokai: {
    background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
    brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e",
    brightYellow: "#f4bf75", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4", brightWhite: "#f9f8f5"
  },
  nord: {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb", brightWhite: "#eceff4"
  }
};

export default function Terminal({ socket, sessionId, isActive = true, theme = "slate", onThemeChange, onBack, tunnelUrl }) {
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const inputHandlerRef = useRef(null);
  const outputHandlerRef = useRef(null);
  
  const [connected, setConnected] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [showThemePicker, setShowThemePicker] = useState(false);

  // Initialize terminal ONCE
  useEffect(() => {
    if (!terminalRef.current || !socket || !sessionId) return;
    if (termRef.current) return; // Already initialized

    const term = new XTerm({
      cursorBlink: true,
      fontSize: window.innerWidth < 768 ? 12 : 14,
      fontFamily: '"SF Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      theme: THEMES[theme]
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    
    term.open(terminalRef.current);
    setTimeout(() => fitAddon.fit(), 100);

    // Join session - get history
    socket.emit("joinSession", sessionId, (result) => {
      if (result.success) {
        setConnected(true);
        setSessionName(result.name);
      } else {
        term.write(`\r\n\x1b[1;31mError: ${result.error}\x1b[0m\r\n`);
      }
    });

    // Global output handler - filter by sessionId
    const handleOutput = (payload) => {
      if (payload.sessionId !== sessionId) return;
      
      const data = payload.data;
      if (data instanceof ArrayBuffer || (data && data.buffer)) {
        term.write(new Uint8Array(data));
      } else if (typeof data === "string") {
        term.write(data);
      } else {
        term.write(String(data));
      }
    };
    outputHandlerRef.current = handleOutput;
    socket.on("output", handleOutput);

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", () => setTimeout(handleResize, 300));

    return () => {
      window.removeEventListener("resize", handleResize);
      if (outputHandlerRef.current) {
        socket.off("output", outputHandlerRef.current);
      }
      if (inputHandlerRef.current) {
        inputHandlerRef.current.dispose();
      }
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [socket, sessionId, theme]);

  // Manage input handler based on isActive
  useEffect(() => {
    if (!termRef.current || !socket || !sessionId) return;
    
    // Remove old input handler
    if (inputHandlerRef.current) {
      inputHandlerRef.current.dispose();
      inputHandlerRef.current = null;
    }
    
    // Only attach when active
    if (isActive) {
      inputHandlerRef.current = termRef.current.onData((data) => {
        socket.emit("input", { sessionId, data });
      });
    }
  }, [isActive, socket, sessionId]);

  // Re-fit when becoming visible
  useEffect(() => {
    if (!isActive || !fitAddonRef.current || !termRef.current) return;
    
    const timer = setTimeout(() => {
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        // Send new size to server
        const term = termRef.current;
        socket.emit("resize", { sessionId, cols: term.cols, rows: term.rows });
      }
    }, 100);
    
    return () => clearTimeout(timer);
  }, [isActive, socket, sessionId]);

  // Update theme
  useEffect(() => {
    if (termRef.current && THEMES[theme]) {
      termRef.current.options.theme = THEMES[theme];
    }
  }, [theme]);

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: THEMES[theme].background }}>
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-2 sm:px-6 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center space-x-2 sm:space-x-3">
          <button
            onClick={onBack}
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded transition"
          >
            ← Back
          </button>
          <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
          <h1 className="text-white text-sm sm:text-base font-semibold truncate max-w-[150px] sm:max-w-none">
            {sessionName || "Terminal"}
          </h1>
        </div>
        
        <div className="flex items-center space-x-2">
          {/* Sites List */}
          <SitesList tunnelUrl={tunnelUrl} />
          
          {/* Theme Picker */}
          <div className="relative">
            <button
              onClick={() => setShowThemePicker(!showThemePicker)}
              className="px-2 sm:px-3 py-1 sm:py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs sm:text-sm font-medium rounded transition flex items-center gap-1"
            >
              <span className="w-3 h-3 rounded-full" style={{ background: THEMES[theme].cursor }} />
              <span className="hidden sm:inline">Theme</span>
            </button>
            
            {showThemePicker && (
              <div className="absolute right-0 top-full mt-2 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 p-2 min-w-[120px]">
                {Object.keys(THEMES).map((t) => (
                  <button
                    key={t}
                    onClick={() => { onThemeChange(t); setShowThemePicker(false); }}
                    className={`w-full px-3 py-2 text-left text-sm rounded flex items-center gap-2 ${
                      theme === t ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    <span className="w-3 h-3 rounded-full" style={{ background: THEMES[t].background, border: "1px solid #555" }} />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 p-2 sm:p-4 overflow-hidden">
        <div
          ref={terminalRef}
          className="w-full h-full rounded-lg overflow-hidden shadow-2xl"
        />
      </div>
    </div>
  );
}
