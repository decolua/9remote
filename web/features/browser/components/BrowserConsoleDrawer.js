"use client";

import { useState } from "react";
import { Terminal, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export default function BrowserConsoleDrawer({ onEval, onClose }) {
  const [expr, setExpr] = useState("");
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    const code = expr.trim();
    if (!code || loading) return;
    vibrate();
    setLoading(true);
    const res = await onEval?.(code);
    setLoading(false);
    setLogs((prev) => [
      ...prev,
      { code, result: res?.result !== undefined ? res.result : (res?.error || "undefined"), ok: res?.ok !== false }
    ]);
    setExpr("");
  };

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 bg-surface border-t border-border-subtle shadow-2xl p-3 flex flex-col gap-2 max-h-[50%] overflow-hidden animate-in slide-in-from-bottom duration-150">
      <div className="flex items-center justify-between pb-1 border-b border-border-subtle">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <Terminal size={14} className="text-brand-500" />
          <span>Console REPL</span>
        </div>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-brand" title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-[80px] overflow-y-auto font-mono text-[11px] space-y-1.5 p-1 bg-surface-2 rounded-brand">
        {logs.length === 0 && <span className="text-text-muted">Type JS expression below to evaluate on the page.</span>}
        {logs.map((l, i) => (
          <div key={i} className="space-y-0.5">
            <div className="text-text-muted flex items-start gap-1">
              <span className="text-brand-500">&gt;</span>
              <span className="break-all">{l.code}</span>
            </div>
            <div className={`pl-3 break-all ${l.ok ? "text-emerald-500" : "text-red-500"}`}>
              {typeof l.result === "object" ? JSON.stringify(l.result, null, 2) : String(l.result)}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 pt-1">
        <input
          type="text"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. document.title, window.location.href"
          className="flex-1 px-2.5 py-1.5 bg-surface-2 rounded-brand font-mono text-xs text-text placeholder-text-muted focus:outline-none"
        />
        <button
          onClick={run}
          disabled={!expr.trim() || loading}
          className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-brand text-xs font-medium"
        >
          Run
        </button>
      </div>
    </div>
  );
}
