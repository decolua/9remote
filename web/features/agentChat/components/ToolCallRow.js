"use client";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { describeTool, toolCategory } from "@/features/agentChat/lib/transcript";
import { CATEGORY_ACCENT, OUTPUT_MAX_HEIGHT } from "@/features/agentChat/constants/agentChatConfig";
import ToolStatusBadge from "./ToolStatusBadge";
import ToolDiffView from "./ToolDiffView";
import BashCard from "./BashCard";

const asText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export default function ToolCallRow({ entry, onOpenFile }) {
  const { toolName, toolInput, toolResponse, status } = entry;
  const category = toolCategory(toolName);
  const accent = CATEGORY_ACCENT[category] || CATEGORY_ACCENT.default;
  const label = describeTool(toolName, toolInput);

  if (toolName === "Bash") {
    return (
      <div className="chat-row">
        <BashCard
          command={toolInput?.command || ""}
          output={asText(toolResponse)}
          status={status}
          cwd={toolInput?.cwd}
        />
      </div>
    );
  }

  if (EDIT_TOOLS.has(toolName) && toolInput?.file_path) {
    return (
      <div className="chat-row">
        <ToolDiffView
          filePath={toolInput.file_path}
          oldContent={toolInput.old_string ?? ""}
          newContent={toolInput.new_string ?? toolInput.content ?? ""}
          isNew={toolName === "Write"}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  const detail = asText(toolResponse) || asText(toolInput);
  const expandable = detail.length > 0;

  return (
    <Collapsible className={`chat-row my-1 border-l-2 py-0.5 pl-3 ${accent}`}>
      <CollapsibleTrigger
        showChevron={expandable}
        className="flex w-full select-none items-center gap-1.5 py-0.5 text-left text-xs text-text-muted transition-colors hover:text-text"
      >
        <span className="shrink-0 font-mono font-semibold text-text">{toolName}</span>
        {label && <span className="shrink-0 text-[10px] text-text-subtle">/</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
        <ToolStatusBadge status={status} />
      </CollapsibleTrigger>

      {expandable && (
        <CollapsibleContent className="mt-1.5 pl-[18px]">
          <pre
            className={`overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border-subtle bg-surface-2 p-2 font-mono text-[11px] ${
              status === "error" ? "text-danger" : "text-text-muted"
            }`}
            style={{ maxHeight: OUTPUT_MAX_HEIGHT }}
          >
            {detail}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
