"use client";

import { memo, useMemo } from "react";
import { AiToolCard } from "./cards/AiToolCard";
import { StepWindow, WINDOW_STEPS } from "./StepWindow";
import { AiBashCard } from "./cards/AiBashCard";
import { AiAgentCard } from "./cards/AiAgentCard";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiPlanModeCard } from "./cards/AiPlanModeCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { getToolCategory } from "../registry";
import { buildTurnRows, splitTurnBlocks } from "../lib/turnRows";
import MarkdownBody from "@/shared/components/ui/MarkdownBody";

// The cards are the cards — a tool call renders the same row it always did, so one tap
// opens its output. What this adds is only the *window*: a long run of steps shows its
// tail, and the rest waits behind "N more".
function StepCard({ row, engine, workspacePath, deferred }) {
  if (row.kind === "thought") return <AiThinkingBlock text={row.text} isLive={row.isLive} />;

  const t = row.tool;
  const cat = getToolCategory(engine, t.name);
  switch (cat) {
    case "plan":
      return <AiPlanModeCard toolName={t.name} input={t.input} />;
    case "bash":
      return <AiBashCard {...t} deferred={deferred} />;
    // A sub-agent owns the tool calls it made — they render nested inside it.
    case "agent":
      return <AiAgentCard {...t} engine={engine} workspacePath={workspacePath} />;
    // Answered question — the host's tool output is the only record of the choice.
    case "question":
      return <AiQuestionCard questions={t.input?.questions || []} answers={t.output || t.error || ""} />;
    default:
      return <AiToolCard {...t} engine={engine} workspacePath={workspacePath} deferred={deferred} />;
  }
}

function ProseRow({ content, isLive }) {
  return (
    <div className="text-sm leading-relaxed text-text py-1.5">
      <MarkdownBody content={content} />
      {isLive && <span className="inline-block w-1.5 h-3.5 bg-brand-500 animate-pulse ml-1 align-middle" />}
    </div>
  );
}

export const AiTurn = memo(function AiTurn({
  messages = [],
  engine = "claude",
  workspacePath = "",
  onResolvePermission,
  isLive = true
}) {
  const rows = useMemo(() => buildTurnRows(messages, engine), [messages, engine]);
  const blocks = useMemo(
    () => splitTurnBlocks(rows, WINDOW_STEPS, { deferred: !isLive }),
    [rows, isLive]
  );

  return (
    <div className="my-1">
      {blocks.map((b) => {
        if (b.type !== "steps") {
          // Prose sits outside the rail: it is the agent talking to the reader, not a
          // step it took, and indenting it would read as one more thing it did.
          if (b.row.kind === "prose") {
            return <ProseRow key={b.key} content={b.row.content} isLive={b.row.isLive} />;
          }
          if (b.row.kind === "permission") {
            const p = b.row.permission;
            return (
              <AiQuestionCard
                key={b.key}
                requestId={p.requestId}
                questions={p.input?.questions || []}
                onResolve={(reqId, answers) => onResolvePermission?.(reqId, "allow", "", answers)}
              />
            );
          }
          return null;
        }

        // The rail marks a run of steps as one piece of work, so a long turn still
        // reads as a unit without boxing every card.
        return (
          <div key={b.key} className="relative pl-2.5 border-l-2 border-border-subtle/50 my-1">
            <StepWindow total={b.rows.length}>
              {(hidden) =>
                (hidden > 0 ? b.rows.slice(hidden) : b.rows).map((row) => (
                  <StepCard key={row.id} row={row} engine={engine} workspacePath={workspacePath} deferred={!isLive} />
                ))
              }
            </StepWindow>
          </div>
        );
      })}
    </div>
  );
});
