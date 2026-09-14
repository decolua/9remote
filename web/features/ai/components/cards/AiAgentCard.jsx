"use client";

import { memo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Loader2 } from "@/shared/components/ui/Icon";
import { AiToolCard } from "./AiToolCard";
import { AiBashCard } from "./AiBashCard";
import { StepWindow } from "../StepWindow";
import { getToolCategory } from "../../registry";
import { LAUNCH_TOOLS, agentLabel } from "../../lib/toolTree";

/** First line of the prompt — enough to tell one sub-agent from another. */
function firstLine(text) {
  const s = String(text || "").split("\n")[0].trim();
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/**
 * A sub-agent (Agent / Task / SendMessage / Workflow …).
 *
 * Collapsed it answers "what is it doing right now": a spinner while running, the
 * tool count climbing, and how many of its children are still going. Expanded it
 * lists those children with the same cards the main timeline uses.
 */
export const AiAgentCard = memo(function AiAgentCard({
  id = "",
  name = "Agent",
  input = null,
  output = "",
  error = "",
  status = "done",
  children = [],
  engine = "claude",
  workspacePath = ""
}) {
  const isRunning = status === "running";
  const isError = Boolean(error || status === "error");
  const runningChildren = children.filter((c) => c.status === "running").length;
  const [expanded, setExpanded] = useState(isError);

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  // An unknown tool name (an engine the registry has not taught yet) still reads as a
  // sub-agent: this card only renders for the "agent" category, so naming the tool is
  // more useful than the literal fallback.
  const isLaunch = LAUNCH_TOOLS.has(name);
  const label = isLaunch ? agentLabel({ input }) : name || "agent";
  const text = isLaunch
    ? firstLine(input?.prompt ?? input?.description ?? input?.message)
    : firstLine(input?.message ?? input?.prompt ?? input?.query);

  return (
    <div className="my-1 text-xs" id={id ? `agent-${id}` : undefined}>
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer select-none transition-colors group/tool"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="shrink-0">
            {isRunning ? (
              <Loader2 size={13} className="animate-spin text-accent" />
            ) : isError ? (
              <AlertCircle size={13} className="text-danger" />
            ) : (
              <CheckCircle2 size={13} className="text-success" />
            )}
          </span>

          <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
            AGENT
          </span>

          <span className="font-mono text-[11px] font-semibold text-brand-500 shrink-0">{label}</span>

          {text && (
            <span className="text-[11px] text-text-muted truncate min-w-0" title={text}>
              {text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {children.length > 0 && (
            <span className="font-mono text-[10px] text-text-subtle" title={`${children.length} sub-agent tool calls`}>
              {isRunning && runningChildren > 0 ? `${runningChildren}/${children.length}` : children.length}
              {" tools"}
            </span>
          )}
          <span className="text-text-muted/50">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 py-1 space-y-0.5">
          {children.length > 0 ? (
            // Same window as the main timeline: a sub-agent that ran forty tools should
            // not dump forty cards into the turn. A sub-agent can itself spawn one, and
            // that grandchild gets this same card, or its calls would have nowhere to go.
            <StepWindow total={children.length}>
              {(hidden) =>
                (hidden > 0 ? children.slice(hidden) : children).map((c) => {
                  switch (getToolCategory(engine, c.name)) {
                    case "agent":
                      return <AiAgentCard key={c.id} {...c} engine={engine} workspacePath={workspacePath} />;
                    case "bash":
                      return <AiBashCard key={c.id} {...c} />;
                    default:
                      return <AiToolCard key={c.id} {...c} engine={engine} workspacePath={workspacePath} />;
                  }
                })
              }
            </StepWindow>
          ) : (
            <div className="text-text-muted italic py-0.5">
              {isRunning ? "Sub-agent started…" : "No tool calls reported."}
            </div>
          )}

          {/* The sub-agent's own report is the only read of its work on this path */}
          {!isRunning && (output || error) && (
            <div className="mt-1 pl-3 border-l-2 border-border-subtle/60 font-mono text-[11px] max-h-[240px] overflow-y-auto select-text">
              <div className={`whitespace-pre-wrap leading-relaxed ${isError ? "text-danger" : "text-text-muted"}`}>
                {typeof (error || output) === "string" ? error || output : JSON.stringify(error || output, null, 2)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
