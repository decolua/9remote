"use client";

import { memo } from "react";
import { Zap, Package, Trash2 } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";

const DEFAULT_STATS = { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0 };

export const AiStatusBar = memo(function AiStatusBar({
  sessionId = "",
  sessionName = "",
  stats: propStats,
  isTurnRunning: propTurnRunning = false,
  onOpenSkills,
  onOpenMcp,
  onClear
}) {
  const storeStats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata);

  const stats = storeStats || propStats || DEFAULT_STATS;
  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const skillsCount = metadata?.skills?.length || 0;
  const mcpCount = metadata?.mcpServers?.length || 0;

  return (
    <div className="h-6 px-3 bg-surface/50 border-t border-border-subtle/50 flex items-center justify-between text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20 gap-3">
      {/* Left: Chat Session Name & Live State */}
      <div className="flex items-center gap-2 min-w-0">
        {sessionName && (
          <span className="font-medium text-text truncate max-w-[180px] font-sans" title={sessionName}>
            {sessionName}
          </span>
        )}

        {isTurnRunning && (
          <div className="flex items-center gap-1 text-brand-500 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-ping" />
            <span className="hidden sm:inline">Active</span>
          </div>
        )}
      </div>

      {/* Right: Skills, MCP, Clear & Cost */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={() => { vibrate(); onOpenSkills?.(); }}
          className="hover:text-text flex items-center gap-1 transition-colors"
          title="Browse agent skills"
        >
          <Zap size={11} className="text-purple-400" />
          <span>Skills ({skillsCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onOpenMcp?.(); }}
          className="hover:text-text flex items-center gap-1 transition-colors"
          title="Browse MCP servers"
        >
          <Package size={11} className="text-sky-400" />
          <span>MCP ({mcpCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onClear?.(); }}
          className="hover:text-rose-400 flex items-center transition-colors p-0.5 rounded hover:bg-surface-2"
          title="Clear chat history"
        >
          <Trash2 size={12} />
        </button>

        {stats.totalCost > 0 && (
          <>
            <span className="text-border-subtle">|</span>
            <span className="text-amber-400 font-semibold">${stats.totalCost.toFixed(3)}</span>
          </>
        )}
      </div>
    </div>
  );
});
