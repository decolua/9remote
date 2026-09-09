"use client";

import { memo } from "react";
import { GitBranch } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";

const DEFAULT_STATS = { inputTokens: 0, outputTokens: 0, totalTurns: 0 };

export const AiStatusBar = memo(function AiStatusBar({
  sessionId = "",
  branch = "main",
  stats: propStats,
  isTurnRunning: propTurnRunning = false
}) {
  const storeStats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const stats = storeStats || propStats || DEFAULT_STATS;
  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const formatTokens = (n) => {
    if (!n) return "0";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className="h-7 px-3 bg-surface border-t border-border-subtle flex items-center justify-between text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20">
      {/* Left: Git branch & Turn state */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1 text-text">
          <GitBranch size={12} className="text-brand-500" />
          <span className="font-semibold">{branch}</span>
        </div>

        {isTurnRunning && (
          <>
            <span className="text-border-subtle">|</span>
            <div className="flex items-center gap-1.5 text-brand-500">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-ping" />
              <span>Responding...</span>
            </div>
          </>
        )}
      </div>

      {/* Right: Tokens & Turns */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1">
          <span>Tokens:</span>
          <span className="text-text">
            {formatTokens(stats.inputTokens)} / {formatTokens(stats.outputTokens)}
          </span>
          {stats.reasoningTokens > 0 && (
            <span className="text-purple-400 text-[10px]">
              (🧠 {formatTokens(stats.reasoningTokens)})
            </span>
          )}
        </div>

        {stats.totalCost > 0 && (
          <>
            <span className="text-border-subtle">|</span>
            <div className="text-amber-400">
              ${stats.totalCost.toFixed(3)}
            </div>
          </>
        )}

        <span className="text-border-subtle">|</span>
        <div>
          {stats.totalTurns || 0} turns
        </div>
      </div>
    </div>
  );
});
