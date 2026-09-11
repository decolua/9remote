"use client";

import { memo } from "react";
import { ListChecks, CheckCircle2, Loader2, Circle } from "@/shared/components/ui/Icon";
import { ModalShell } from "./ModalShell";

const STATUS_META = {
  completed: { icon: CheckCircle2, cls: "text-emerald-400", line: "line-through text-text-muted" },
  in_progress: { icon: Loader2, cls: "text-sky-400 animate-spin", line: "text-sky-300 font-semibold" },
  pending: { icon: Circle, cls: "text-text-muted", line: "text-text" },
};

// The session's task checklist (TaskCreate/TaskUpdate or a todo list). Same data
// the pinned strip above the composer renders — this is the full view.
export const TasksModal = memo(function TasksModal({ tasks = [], onClose }) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const pending = total - completed - inProgress;

  return (
    <ModalShell
      icon={<ListChecks size={14} />}
      iconClass="bg-brand-500/15 text-brand-500"
      title={`Tasks (${total})`}
      subtitle="Checklist the agent is working through"
      onClose={onClose}
    >
      <div className="grid grid-cols-4 gap-2 px-4 py-3 border-b border-border-subtle bg-bg text-center shrink-0">
        {[
          { label: "TOTAL", value: total, cls: "text-text" },
          { label: "RUNNING", value: inProgress, cls: "text-sky-400" },
          { label: "DONE", value: completed, cls: "text-emerald-400" },
          { label: "PENDING", value: pending, cls: "text-text-muted" },
        ].map((s) => (
          <div key={s.label} className="p-2 rounded-brand bg-surface-2/40">
            <div className="text-[10px] text-text-muted font-mono">{s.label}</div>
            <div className={`text-base font-bold ${s.cls}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="p-4 flex-1 overflow-y-auto space-y-2 custom-scrollbar">
        {total === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            No tasks in this session yet.
          </div>
        ) : (
          tasks.map((task, idx) => {
            const meta = STATUS_META[task.status] || STATUS_META.pending;
            const Icon = meta.icon;
            return (
              <div
                key={task.id || idx}
                className="p-3 rounded-brand border border-border-subtle bg-surface-2/40 flex items-start gap-2.5"
              >
                <Icon size={14} className={`${meta.cls} shrink-0 mt-0.5`} />
                <div className="min-w-0 flex-1">
                  <div className={`text-xs ${meta.line}`}>
                    {task.subject || task.activeForm || "(untitled task)"}
                  </div>
                  {task.activeForm && task.status === "in_progress" && (
                    <div className="text-[11px] text-sky-400/80 font-mono mt-0.5 truncate">
                      {task.activeForm}
                    </div>
                  )}
                </div>
                {task.taskId && (
                  <span className="text-[10px] font-mono text-text-muted shrink-0">#{task.taskId}</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
});
