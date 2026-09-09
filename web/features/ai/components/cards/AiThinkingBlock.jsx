"use client";

import { memo, useState } from "react";
import { Sparkles, ChevronDown, ChevronRight } from "@/shared/components/ui/Icon";

export const AiThinkingBlock = memo(function AiThinkingBlock({ text = "", isLive = false }) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  return (
    <div className="my-1 rounded-brand border border-purple-500/20 bg-purple-500/5 text-xs overflow-hidden">
      {/* 1-Line Minimalist Chip */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="h-7 px-2.5 flex items-center justify-between cursor-pointer select-none hover:bg-purple-500/10 transition-colors text-purple-400"
      >
        <div className="flex items-center gap-1.5 font-medium text-[11px]">
          <Sparkles size={12} className={isLive ? "animate-pulse text-purple-400" : "text-purple-400/70"} />
          <span>{isLive ? "Thinking..." : "Thought process"}</span>
        </div>

        <div className="flex items-center gap-1 text-[10px] text-text-muted">
          <span>{expanded ? "Collapse" : "Expand"}</span>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </div>

      {expanded && (
        <div className="p-2.5 border-t border-purple-500/15 bg-bg/50 font-mono text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap max-h-[240px] overflow-y-auto select-text">
          {text}
        </div>
      )}
    </div>
  );
});
