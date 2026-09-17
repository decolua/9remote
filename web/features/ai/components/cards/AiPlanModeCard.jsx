"use client";

import { memo } from "react";
import { ListChecks, CheckCircle2 } from "@/shared/components/ui/Icon";

// The plan a turn is working through, as either engine states it: claude's plan-mode pair
// (`EnterPlanMode`/`ExitPlanMode`, each carrying a `reason`) and codex's `update_plan`,
// whose text is the plan itself. The second one used to fall to the generic card and print
// raw JSON, because this card only ever looked for a reason.
export const AiPlanModeCard = memo(function AiPlanModeCard({ toolName = "EnterPlanMode", input = {} }) {
  const plan = typeof input?.plan === "string" ? input.plan.trim() : "";
  if (plan) return <PlanText plan={plan} explanation={input?.explanation || ""} />;

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
          Plan mode reads files and drafts an approach — nothing is applied without your
          review, in whichever CLI this chat is running.
        </div>
      )}
    </div>
  );
});

/**
 * A plan the CLI states as TEXT (codex's `update_plan`, streamed piece by piece as it is
 * written). Monospace and preserved, because a plan is a list and its indentation carries
 * the structure — the same reason the TUI prints it that way.
 */
const PlanText = memo(function PlanText({ plan, explanation = "" }) {
  return (
    <div className="p-3.5 rounded-brand-lg border border-brand-500/30 bg-brand-500/10 text-text my-2 text-xs flex flex-col gap-2">
      <div className="flex items-center gap-2 font-semibold">
        <ListChecks size={16} className="text-brand-500" />
        <span>Plan</span>
      </div>
      <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words pl-6 max-h-[320px] overflow-y-auto">
        {plan}
      </pre>
      {explanation && (
        <div className="text-[11px] text-text-muted pl-6 italic">{explanation}</div>
      )}
    </div>
  );
});
