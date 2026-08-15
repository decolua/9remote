"use client";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { toolCategory } from "@/features/agentChat/lib/transcript";
import { CATEGORY_ACCENT } from "@/features/agentChat/constants/agentChatConfig";
import ToolCallRow from "./ToolCallRow";

// A run of identical settled calls, folded into one line: "Read ×5 / a.js, b.js, +3 more".
export default function ToolGroupRow({ row, onOpenFile }) {
  const accent = CATEGORY_ACCENT[toolCategory(row.toolName)] || CATEGORY_ACCENT.default;

  return (
    <Collapsible className={`chat-row my-1 border-l-2 py-0.5 pl-3 ${accent}`}>
      <CollapsibleTrigger className="flex w-full select-none items-center gap-1.5 py-0.5 text-left text-xs text-text-muted transition-colors hover:text-text">
        <span className="shrink-0 font-mono font-semibold text-text">{row.toolName}</span>
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-subtle">
          ×{row.count}
        </span>
        <span className="shrink-0 text-[10px] text-text-subtle">/</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.preview}</span>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1 space-y-0.5 border-l border-border-subtle pl-2">
        {row.entries.map((entry, i) => (
          <ToolCallRow key={`${row.key}-${i}`} entry={entry} onOpenFile={onOpenFile} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
