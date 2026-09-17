"use client";

import { memo } from "react";
import { Eye, CheckCircle2 } from "@/shared/components/ui/Icon";

/**
 * Codex entering and leaving code review.
 *
 * The CLI declares them as two items (`enteredReviewMode` / `exitedReviewMode`), and the
 * pair is one happening: a review, with the text it was asked to perform. Drawn as a card
 * of its own because the vocabulary is its own — this is not plan mode, and the plan card
 * that used to draw it said "Plan Mode Activated" and named the wrong engine.
 */
export const AiReviewCard = memo(function AiReviewCard({ toolName = "enteredReviewMode", input = {} }) {
  const entering = toolName === "enteredReviewMode";
  const review = String(input?.review || "").trim();

  return (
    <div
      className={`p-3.5 rounded-brand-lg border flex flex-col gap-2 my-2 text-xs ${
        entering ? "bg-brand-500/10 border-brand-500/30 text-text" : "bg-success/10 border-success/30 text-success"
      }`}
    >
      <div className="flex items-center gap-2 font-semibold">
        {entering ? <Eye size={16} className="text-brand-500" /> : <CheckCircle2 size={16} className="text-success" />}
        <span>{entering ? "Code review started" : "Code review finished"}</span>
      </div>
      {review && (
        <div className="text-xs text-text leading-relaxed font-sans pl-6">
          <span className="text-text-muted">Reviewing: </span>
          {review}
        </div>
      )}
    </div>
  );
});
