"use client";

import { memo, useMemo } from "react";
import { AiToolCard } from "./cards/AiToolCard";
import { StepWindow, WINDOW_STEPS } from "./StepWindow";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { renderToolCard } from "./cards/toolCards";
import { buildTurnRows, splitTurnBlocks } from "../lib/turnRows";
import MarkdownBody from "@/shared/components/ui/MarkdownBody";

// The cards are the cards — a tool call renders the same row it always did, so one tap
// opens its output. What this adds is only the *window*: a long run of steps shows its
// tail, and the rest waits behind "N more".
function StepCard({ row, engine, workspacePath, deferred }) {
  if (row.kind === "thought") return <AiThinkingBlock text={row.text} isLive={row.isLive} />;
  // Checked before `row.tool`: a diff row carries no tool, and reading one off it threw.
  if (row.kind === "diff") {
    const d = row.diff;
    return (
      <AiDiffCard
        file={d.file}
        patch={d.patch}
        diff={d.diff}
        content={d.content}
        workspacePath={workspacePath}
      />
    );
  }

  const t = row.tool;
  // A tool family with its own card renders it; everything else is the generic row, which
  // reads any call from its name, input and output.
  return (
    renderToolCard(engine, t, { workspacePath, deferred }) ||
    <AiToolCard {...t} engine={engine} workspacePath={workspacePath} deferred={deferred} />
  );
}

function ProseRow({ content, isLive }) {
  return (
    // wrap-anywhere, not break-words: only `anywhere` shrinks min-content, so a path
    // with no space to break on wraps instead of widening the column into a scrollbar.
    <div className="text-sm leading-relaxed text-text py-1.5 wrap-anywhere">
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
                onResolve={onResolvePermission}
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
}, (prev, next) => {
  // `messages` is a freshly sliced array on every store update, so identity alone would
  // fail here and re-render every turn in the log once per streamed token. What matters
  // is whether the message objects themselves moved — a new delta replaces exactly one.
  if (prev.messages.length !== next.messages.length) return false;
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) return false;
  }
  return (
    prev.engine === next.engine &&
    prev.workspacePath === next.workspacePath &&
    prev.isLive === next.isLive &&
    prev.onResolvePermission === next.onResolvePermission
  );
});
