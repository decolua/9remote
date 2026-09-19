"use client";

import { memo, useMemo } from "react";
import { ChevronLeft, ChevronRight, X, GitBranch, ListChecks } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useKanbanStore, columnsOf, visibleTasks } from "@/shared/stores/kanbanStore";
import { useJarvisStore } from "@/shared/stores/jarvisStore";
import { KANBAN_STATUSES } from "@/shared/lib/jarvisConstants";

// Column chrome, derived from the shared status list so a new column cannot
// appear here without appearing everywhere else (agent reducer included).
const COLUMN_META = {
  todo: { label: "Todo", cls: "text-text-muted", dot: "bg-text-muted/60" },
  in_progress: { label: "In Progress", cls: "text-sky-400", dot: "bg-sky-400" },
  needs_input: { label: "Needs Input", cls: "text-amber-400", dot: "bg-amber-400" },
  done: { label: "Done", cls: "text-emerald-400", dot: "bg-emerald-400" }
};

const CARD_CLS = {
  needs_input: "border-amber-500/60 animate-pulse",
  done: "border-border-subtle/60 opacity-70",
};

function KanbanCard({ task, prev, next, showWorkspace }) {
  const moveTask = useKanbanStore((s) => s.moveTask);
  const deleteTask = useKanbanStore((s) => s.deleteTask);
  const workspaceName = showWorkspace && task.workspace
    ? String(task.workspace).split("/").filter(Boolean).pop()
    : "";

  return (
    <div
      className={`group relative p-2 rounded-brand border border-border-subtle/80 bg-surface-2/80 text-xs shadow-sm
        transition-all duration-150 ease-out hover:bg-surface-3/60 hover:border-border/80 hover:-translate-y-px
        animate-in fade-in slide-in-from-bottom-1 duration-150 ${CARD_CLS[task.status] || ""}`}
    >
      <div className="pr-4 font-medium text-text break-words">{task.title}</div>
      {(task.engine || task.branch || workspaceName) && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[10px] text-text-muted">
          {workspaceName && (
            <span className="px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-400 truncate max-w-[110px]" title={task.workspace}>
              {workspaceName}
            </span>
          )}
          {task.engine && (
            <span className="px-1.5 py-0.5 rounded bg-surface-3/60 font-mono truncate max-w-[110px]">{task.engine}</span>
          )}
          {task.branch && (
            <span className="inline-flex items-center gap-0.5 min-w-0">
              <GitBranch size={9} className="shrink-0" />
              <span className="truncate">{task.branch}</span>
            </span>
          )}
        </div>
      )}
      {task.sessionId && !task.auto && (
        <div className="mt-1 text-[9px] font-mono text-text-muted/70 truncate">{task.sessionId}</div>
      )}
      {task.question && <div className="mt-1 text-[10px] leading-relaxed text-amber-400/90 line-clamp-3">{task.question}</div>}
      {task.summary && <div className="mt-1 text-[10px] leading-relaxed text-text-muted line-clamp-3">{task.summary}</div>}

      {/* Auto cards mirror their session — the session decides, so no hand moves.
          Hand moves on manual cards: one column left/right plus delete; touch has
          no hover, so the buttons stay visible there (same reveal as WorktreePanel). */}
      {!task.auto && (
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
        {prev && (
          <button
            type="button"
            onClick={() => { vibrate(); moveTask(task.id, prev); }}
            aria-label="Move left"
            className="p-0.5 rounded text-text-muted hover:text-text hover:bg-surface-3"
          >
            <ChevronLeft size={12} />
          </button>
        )}
        {next && (
          <button
            type="button"
            onClick={() => { vibrate(); moveTask(task.id, next); }}
            aria-label="Move right"
            className="p-0.5 rounded text-text-muted hover:text-text hover:bg-surface-3"
          >
            <ChevronRight size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => { vibrate(); deleteTask(task.id); }}
          aria-label="Delete task"
          className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-surface-3"
        >
          <X size={12} />
        </button>
      </div>
      )}
    </div>
  );
}

/** The board the user watches — this workspace's cards, or every workspace's. */
export const KanbanBoard = memo(function KanbanBoard({ workspacePath = "" }) {
  // Subscribe to the tasks OBJECT (stable reference), derive the grouping in a
  // memo — a selector returning a fresh object every call sends useSyncExternalStore
  // into an infinite snapshot loop.
  const tasks = useKanbanStore((s) => s.board.tasks);
  const boardScope = useJarvisStore((s) => s.settings.boardScope);
  const setSettings = useJarvisStore((s) => s.setSettings);
  const all = boardScope === "all";
  const visible = useMemo(() => (all ? tasks : visibleTasks(tasks, workspacePath)), [tasks, workspacePath, all]);
  const columns = useMemo(() => columnsOf(visible), [visible]);
  const total = Object.keys(visible).length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1 flex-shrink-0">
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">{total} cards</span>
        <button
          type="button"
          onClick={() => { vibrate(); setSettings({ boardScope: all ? "workspace" : "all" }); }}
          className={`ml-auto text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
            all ? "border-brand-500/50 text-brand-400 bg-brand-500/10" : "border-border-subtle text-text-muted hover:text-text"
          }`}
          title={all ? "Showing cards from every workspace" : "Showing cards from this workspace only"}
        >
          {all ? "All workspaces" : "This workspace"}
        </button>
      </div>
      {!all && Object.keys(tasks).length > total && (
        <button
          type="button"
          onClick={() => { vibrate(); setSettings({ boardScope: "all" }); }}
          className="mx-2 mb-1 text-left text-[10px] text-text-muted/80 hover:text-text-muted flex-shrink-0"
        >
          +{Object.keys(tasks).length - total} cards in other workspaces — tap to show all
        </button>
      )}

      {!total ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted p-6">
          <ListChecks size={32} className="opacity-50" />
          <span className="text-sm">Nothing on the board.</span>
          <span className="text-xs text-center leading-relaxed">Open sessions land here automatically; ask Jarvis — “create 2 tasks: API login and UI login” — to add work.</span>
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto custom-scrollbar p-2 pt-1">
      <div
        className="min-w-[560px] h-full grid gap-2"
        style={{ gridTemplateColumns: `repeat(${KANBAN_STATUSES.length}, minmax(0, 1fr))` }}
      >
        {KANBAN_STATUSES.map((id) => {
          const meta = COLUMN_META[id] || { label: id, cls: "text-text-muted", dot: "bg-text-muted/60" };
          const cards = columns[id] || [];
          const idx = KANBAN_STATUSES.indexOf(id);
          const prev = KANBAN_STATUSES[Math.max(0, idx - 1)];
          const next = KANBAN_STATUSES[Math.min(KANBAN_STATUSES.length - 1, idx + 1)];
          return (
            <section
              key={id}
              className="min-w-0 flex flex-col gap-1.5 bg-surface-2/30 rounded-brand-lg p-1.5"
              aria-label={`${meta.label} column`}
            >
              <h4 className={`flex items-center gap-1.5 px-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
                <span className="truncate">{meta.label}</span>
                <span className="ml-auto px-1.5 py-px rounded-full bg-surface-3/60 text-[9px] font-mono text-text-muted">{cards.length}</span>
              </h4>
              <div className="flex-1 flex flex-col gap-1.5">
                {cards.map((task) => (
                  <KanbanCard key={task.id} task={task} showWorkspace={all} prev={id === "todo" ? null : prev} next={id === "done" ? null : next} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
});
