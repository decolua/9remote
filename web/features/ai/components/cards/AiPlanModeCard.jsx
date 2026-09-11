"use client";

import { memo } from "react";
import { ListChecks, CheckCircle2 } from "@/shared/components/ui/Icon";

export const AiPlanModeCard = memo(function AiPlanModeCard({ toolName = "EnterPlanMode", input = {} }) {
  const isEnter = toolName === "EnterPlanMode";
  const reason = input?.reason || (isEnter ? "Exploring codebase and designing implementation approach" : "Implementation plan finalized");

  return (
    <div
      className={`p-3.5 rounded-brand-lg border flex flex-col gap-2 my-2 text-xs ${
        isEnter
          ? "bg-brand-500/10 border-brand-500/30 text-text"
          : "bg-success/10 border-success/30 text-success"
      }`}
    >
      <div className="flex items-center justify-between font-semibold">
        <div className="flex items-center gap-2">
          {isEnter ? <ListChecks size={16} className="text-brand-500" /> : <CheckCircle2 size={16} className="text-success" />}
          <span>{isEnter ? "Plan Mode Activated" : "Plan Mode Completed"}</span>
        </div>
        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-surface-2 text-text-muted">
          {toolName}
        </span>
      </div>

      <div className="text-xs text-text leading-relaxed font-sans pl-6">
        <span className="text-text-muted">Reason: </span>
        {reason}
      </div>

      {isEnter && (
        <div className="text-[11px] text-text-muted/80 italic pl-6 select-none">
          In Plan Mode, Claude only reads files and drafts architecture. No code changes will be applied without your review.
        </div>
      )}
    </div>
  );
});