import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm";

export class TerminalManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.term = null;
    this.fitAddon = null;
    this.onDataCallback = null;
  }

  init() {
    const container = document.getElementById(this.containerId);
    
    // Clear container to remove any old terminal DOM
    if (container) {
      container.innerHTML = "";
    }

    this.term = new Terminal({
      cursorBlink: true,
      // Responsive font size for mobile
      fontSize: window.innerWidth < 768 ? 12 : 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      // Same theme as local /terminal (slate theme)
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#3b82f6",
        black: "#1e293b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#cbd5e1",
        brightBlack: "#475569",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#f1f5f9",
        selection: "rgba(59, 130, 246, 0.3)"
      },
      scrollback: 10000,
      // Better mobile support
      convertEol: true,
      disableStdin: false
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.term.open(container);

    // Clear any initial garbage output
    setTimeout(() => {
      this.term.clear();
      this.fit();
    }, 200);

    // Handle input
    this.term.onData((data) => {
      if (this.onDataCallback) {
        this.onDataCallback(data);
      }
    });

    // Handle resize with debounce for mobile
    let resizeTimeout;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.fit(), 100);
    });

    // Re-fit on orientation change (mobile)
    window.addEventListener("orientationchange", () => {
      setTimeout(() => this.fit(), 300);
    });

    return this;
  }

  fit() {
    if (this.fitAddon) {
      this.fitAddon.fit();
    }
  }

  write(data) {
    if (this.term) {
      this.term.write(data);
    }
  }

  onData(callback) {
    this.onDataCallback = callback;
  }

  getSize() {
    return {
      cols: this.term?.cols || 80,
      rows: this.term?.rows || 24
    };
  }

  dispose() {
    // Remove all event listeners
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    
    if (this._orientationHandler) {
      window.removeEventListener("orientationchange", this._orientationHandler);
      this._orientationHandler = null;
    }
    
    // Dispose terminal instance
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
    
    this.fitAddon = null;
    this.onDataCallback = null;
    
    // Clear container DOM
    const container = document.getElementById(this.containerId);
    if (container) {
      container.innerHTML = "";
    }
  }
}
