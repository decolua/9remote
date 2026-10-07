"use client";

import { useState } from "react";
import { Terminal } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import BrowserModalShell from "./BrowserModalShell";

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
    <BrowserModalShell
      wide
      title="Console REPL"
      icon={<Terminal size={14} className="text-brand-500 shrink-0" />}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="e.g. document.title, window.location.href"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 min-w-0 px-2.5 py-1.5 bg-surface-2 rounded-brand font-mono text-xs text-text placeholder-text-muted focus:outline-none"
          />
          <button
            onClick={run}
            disabled={!expr.trim() || loading}
            className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-brand text-xs font-medium transition-colors"
          >
            Run
          </button>
        </div>
      }
    >
      <div className="min-h-[160px] max-h-[40vh] overflow-y-auto font-mono text-[11px] space-y-1.5 p-2 bg-surface-2 rounded-brand">
        {logs.length === 0 && <span className="text-text-muted">Type a JS expression below to evaluate on the page.</span>}
        {logs.map((l, i) => (
          <div key={i} className="space-y-0.5">
            <div className="text-text-muted flex items-start gap-1">
              <span className="text-brand-500">&gt;</span>
              <span className="break-all">{l.code}</span>
            </div>
            <div className={`pl-3 break-all whitespace-pre-wrap ${l.ok ? "text-emerald-500" : "text-red-500"}`}>
              {typeof l.result === "object" ? JSON.stringify(l.result, null, 2) : String(l.result)}
            </div>
          </div>
        ))}
      </div>
    </BrowserModalShell>
  );
}
