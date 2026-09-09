// test-claude-web/src/components/StatusBar.jsx
import React from "react";

export function StatusBar({
  branch = "main",
  model = "sonnet",
  stats = {},
  sessionId = "",
  onOpenModal,
}) {
  const formatTokens = (n) => {
    if (!n) return "0";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const totalUsed = (stats.inputTokens || 0) + (stats.outputTokens || 0);
  const maxContext = (model || "").includes("[1m]") ? 1000000 : 200000;
  const pct = Math.min(100, Math.max(1, Math.round((totalUsed / maxContext) * 100)));
  const cost = Number(stats.totalCost || 0);

  return (
    <footer className="h-7 px-4 bg-slate-950 border-t border-white/10 flex items-center justify-between text-[11px] font-mono text-slate-400 select-none flex-shrink-0 z-40">
      {/* Left: Git Branch & Session */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-slate-300">
          <span className="text-purple-400">🌿</span>
          <span className="font-semibold">{branch}</span>
        </div>
        <span className="text-slate-600">|</span>
        <button
          onClick={() => onOpenModal && onOpenModal("model")}
          className="flex items-center gap-1 hover:text-white transition-colors text-sky-400"
          title="Bấm để đổi Model (/model)"
        >
          <span>🤖</span>
          <span className="truncate max-w-[150px]">{model || "sonnet"}</span>
        </button>
        {sessionId && (
          <>
            <span className="text-slate-600">|</span>
            <span className="text-slate-500 truncate max-w-[100px]" title={sessionId}>
              #{sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>

      {/* Center: Context Window Bar */}
      <div
        onClick={() => onOpenModal && onOpenModal("doctor")}
        className="hidden md:flex items-center gap-2 cursor-pointer hover:text-slate-200 transition-colors"
        title="Dung lượng bộ nhớ ngữ cảnh (/context, /doctor)"
      >
        <span>Context:</span>
        <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden flex">
          <div
            className={`h-full transition-all ${pct > 80 ? "bg-rose-500" : pct > 50 ? "bg-amber-400" : "bg-blue-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-slate-300 text-[10px]">{formatTokens(totalUsed)} / {formatTokens(maxContext)} ({pct}%)</span>
      </div>

      {/* Right: Tokens, Cost & Quick hotkey */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" title="Tokens: Vào / Ra">
          <span>Tokens:</span>
          <span className="text-slate-300">
            {formatTokens(stats.inputTokens)} / {formatTokens(stats.outputTokens)}
          </span>
          {stats.cacheReadTokens > 0 && (
            <span className="text-emerald-400 text-[10px]">
              (⚡{formatTokens(stats.cacheReadTokens)})
            </span>
          )}
        </div>
        <span className="text-slate-600">|</span>
        <div className="text-amber-300 font-semibold" title="Tổng chi phí phiên">
          ${cost.toFixed(4)}
        </div>
        <span className="text-slate-600">|</span>
        <div className="text-[10px] text-slate-500">
          <span className="border border-white/10 px-1 py-0.5 rounded text-slate-400">Ctrl+~</span>
        </div>
      </div>
    </footer>
  );
}
