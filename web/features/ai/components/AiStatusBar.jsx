"use client";

import { memo } from "react";
import { Zap, Package, Trash2 } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";

export const AiStatusBar = memo(function AiStatusBar({
  sessionId = "",
  sessionName = "",
  isTurnRunning: propTurnRunning = false,
  onOpenSkills,
  onOpenMcp,
  onClear
}) {
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata);

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const skillsCount = metadata?.skills?.length || 0;
  const mcpCount = metadata?.mcpServers?.length || 0;

  return (
    <div className="relative h-6 px-3 bg-surface/50 border-t border-border-subtle/50 flex items-center justify-end text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20 gap-3">
      {/* Sweep across the foot of the composer while a turn runs */}
      {isTurnRunning && <span className="composer-beam" aria-hidden="true" />}
      {/* Left: Live State indicator only */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
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
          <Zap size={11} className="text-accent shrink-0" />
          <span>Skills ({skillsCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onOpenMcp?.(); }}
          className="hover:text-text flex items-center gap-1 transition-colors"
          title="Browse MCP servers"
        >
          <Package size={11} className="text-accent shrink-0" />
          <span>MCP ({mcpCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onClear?.(); }}
          className="hover:text-danger flex items-center transition-colors p-0.5 rounded hover:bg-surface-2"
          title="Clear chat history"
        >
          <Trash2 size={12} />
        </button>

        {/* Cost readout hidden on request — stats still tracked in the store, re-enable
            by rendering `useAiStore((s) => s.bySession[sessionId]?.stats)?.totalCost`. */}
        {/* {stats.totalCost > 0 && (
          <>
            <span className="text-border-subtle">|</span>
            <span className="text-text font-semibold">${stats.totalCost.toFixed(3)}</span>
          </>
        )} */}
      </div>
    </div>
  );
});
