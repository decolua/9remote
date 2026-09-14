"use client";

import { memo, useState, useMemo } from "react";
import { ListChecks, CheckCircle2, Circle, ChevronDown, ChevronRight, Play } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";

const EMPTY_TASKS = [];

/**
 * Inline task checklist card.
 * TaskCreate/TaskUpdate emit tool events — we track tasks in the AI store's
 * session metadata and render them as a compact progress bar at the top of the chat.
 *
 * Collapsed: "TASKS 2/5 · Running tests"
 * Expanded: full checklist with status icons
 */
export const AiTaskCard = memo(function AiTaskCard({ sessionId = "" }) {
  const [expanded, setExpanded] = useState(false);
  const rawTasks = useAiStore((s) => s.bySession[sessionId]?.tasks);
  const tasks = useMemo(() => {
    if (!Array.isArray(rawTasks)) return EMPTY_TASKS;
    return rawTasks.filter((t) => Boolean(t && t.subject && String(t.subject).trim().length > 0));
  }, [rawTasks]);

  if (tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.find((t) => t.status === "in_progress");
  const allDone = completed === tasks.length;

  return (
    <div className="px-4 sm:px-6 py-1 border-b border-border-subtle/40 bg-surface-2/20 shrink-0 text-xs select-none">
      {/* 1-line summary row */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer data-pane-control transition-colors group"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {allDone ? (
            <CheckCircle2 size={13} className="text-success shrink-0" />
          ) : inProgress ? (
            <ListChecks size={13} className="text-brand-500 shrink-0" />
          ) : (
            <ListChecks size={13} className="text-text-muted shrink-0" />
          )}

          <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
            TASKS
          </span>

          <span className="font-mono text-[11px] text-text-muted shrink-0">
            {completed}/{tasks.length}
          </span>

          {inProgress && (
            <span className="text-[11px] text-brand-500 truncate min-w-0 font-medium">
              {inProgress.activeForm || inProgress.subject}
            </span>
          )}

          <span className="text-text-muted/50 shrink-0 ml-auto">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </div>
      </div>

      {/* Expanded task list */}
      {expanded && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 py-1 space-y-0.5 animate-in fade-in duration-100">
          {tasks.map((t, idx) => (
            <div key={t.id || idx} className="flex items-center gap-2 py-0.5">
              {t.status === "completed" ? (
                <CheckCircle2 size={12} className="text-success shrink-0" />
              ) : t.status === "in_progress" ? (
                <Play size={10} className="text-brand-500 fill-brand-500 shrink-0" />
              ) : (
                <Circle size={12} className="text-text-muted/50 shrink-0" />
              )}
              <span
                className={`text-[11px] truncate ${
                  t.status === "completed"
                    ? "line-through text-text-muted/60"
                    : t.status === "in_progress"
                    ? "text-text font-medium"
                    : "text-text-muted"
                }`}
              >
                {t.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
