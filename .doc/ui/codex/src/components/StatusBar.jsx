// test-codex-web/src/components/StatusBar.jsx
import React from "react";

export function StatusBar({
  branch = "main",
  model = "gemini",
  stats = {},
  threadId = "",
  onOpenModal,
}) {
  const formatTokens = (n) => {
    if (!n) return "0";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const totalUsed = (stats.inputTokens || 0) + (stats.outputTokens || 0);

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
          className="flex items-center gap-1 hover:text-white transition-colors text-emerald-400"
          title="Bấm để đổi Model Codex (/model)"
        >
          <span>🤖</span>
          <span className="truncate max-w-[150px]">{model || "codex"}</span>
        </button>
        {threadId && (
          <>
            <span className="text-slate-600">|</span>
            <span className="text-slate-500 truncate max-w-[120px]" title={threadId}>
              thread #{threadId.slice(0, 8)}
            </span>
          </>
        )}
      </div>

      {/* Right: Tokens, Turns & Quick hotkey */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" title="Tokens: Vào / Ra / Suy luận">
          <span>Tokens:</span>
          <span className="text-slate-300">
            {formatTokens(stats.inputTokens)} / {formatTokens(stats.outputTokens)}
          </span>
          {stats.reasoningTokens > 0 && (
            <span className="text-purple-400 text-[10px]">
              (🧠 {formatTokens(stats.reasoningTokens)})
            </span>
          )}
        </div>
        <span className="text-slate-600">|</span>
        <div className="text-slate-400">
          {stats.totalTurns || 0} lượt
        </div>
        <span className="text-slate-600">|</span>
        <div className="text-[10px] text-slate-500">
          <span className="border border-white/10 px-1 py-0.5 rounded text-slate-400">Ctrl+~</span>
        </div>
      </div>
    </footer>
  );
}
