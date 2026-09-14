"use client";

import { memo, useState } from "react";
import { Sparkles, ChevronDown, ChevronRight } from "@/shared/components/ui/Icon";

export const AiThinkingBlock = memo(function AiThinkingBlock({ text = "", isLive = false, defaultOpen = false }) {
  const [expanded, setExpanded] = useState(defaultOpen);

  // Whitespace-only runs carry nothing — don't render an empty "Thought process" toggle
  if (!text?.trim()) return null;

  return (
    <div className="my-1.5 text-xs select-none">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text py-0.5 transition-colors cursor-pointer group"
      >
        <Sparkles size={12} className={isLive ? "animate-pulse text-success" : "text-success"} />
        <span className="italic">{isLive ? "Thinking..." : "Thought process"}</span>
        <span className="text-text-muted/50 group-hover:text-text-muted">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 pl-3.5 border-l-2 border-border-subtle/80 font-mono text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap max-h-[260px] overflow-y-auto custom-scrollbar select-text py-1">
          {text}
        </div>
      )}
    </div>
  );
});
