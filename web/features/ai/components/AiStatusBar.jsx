"use client";

import { memo } from "react";
import { GitBranch, Zap, Package, Trash2 } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";

const DEFAULT_STATS = { inputTokens: 0, outputTokens: 0, totalTurns: 0 };

export const AiStatusBar = memo(function AiStatusBar({
  sessionId = "",
  branch = "main",
  stats: propStats,
  isTurnRunning: propTurnRunning = false,
  onOpenSkills,
  onOpenMcp,
  onClear,
  onModeChange
}) {
  const storeStats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const permissionMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode || "default");
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata);

  const stats = storeStats || propStats || DEFAULT_STATS;
  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const skillsCount = metadata?.skills?.length || 0;
  const mcpCount = metadata?.mcpServers?.length || 0;

  const formatTokens = (n) => {
    if (!n) return "0";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <div className="h-7 px-2.5 bg-surface border-t border-border-subtle flex items-center justify-between text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20 gap-2">
      {/* Left: Branch & Permission Mode */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1 text-text shrink-0">
          <GitBranch size={12} className="text-brand-500" />
          <span className="font-semibold truncate max-w-[110px]">{branch}</span>
        </div>

        <select
          value={permissionMode}
          onChange={(e) => onModeChange?.(e.target.value)}
          className="bg-transparent border border-border-subtle hover:border-text-muted rounded px-1 py-0.5 text-[10px] text-text-muted hover:text-text outline-none cursor-pointer font-sans"
          title="Change permission mode"
        >
          <option value="default" className="bg-surface text-text">Perm: Default</option>
          <option value="acceptEdits" className="bg-surface text-text">Perm: Accept Edits</option>
          <option value="auto" className="bg-surface text-text">Perm: Auto</option>
          <option value="bypassPermissions" className="bg-surface text-text">Perm: Bypass</option>
          <option value="plan" className="bg-surface text-text">Perm: Plan Mode</option>
        </select>

        {isTurnRunning && (
          <div className="flex items-center gap-1 text-brand-500 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-ping" />
            <span className="hidden sm:inline">Active</span>
          </div>
        )}
      </div>

      {/* Right: Quick actions & Stats */}
      <div className="flex items-center gap-2 shrink-0">
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
          className="hover:text-rose-400 flex items-center transition-colors"
          title="Clear chat history"
        >
          <Trash2 size={12} />
        </button>

        <span className="text-border-subtle">|</span>

        <div className="flex items-center gap-1">
          <span>{formatTokens(stats.inputTokens)}/{formatTokens(stats.outputTokens)}</span>
          {stats.reasoningTokens > 0 && (
            <span className="text-purple-400 text-[10px]">
              (🧠 {formatTokens(stats.reasoningTokens)})
            </span>
          )}
        </div>

        {stats.totalCost > 0 && (
          <span className="text-amber-400">${stats.totalCost.toFixed(3)}</span>
        )}
      </div>
    </div>
  );
});
