"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";
import { runningAsync, taskActivity } from "../lib/toolTree";
import { describeActivity } from "../lib/liveStatus";
import { taskElapsedMs } from "../lib/harnessTasks";
import { clockText } from "../lib/taskClock";
import { AgentTaskModal } from "./modals/AgentTaskModal";

const EMPTY = [];

// Two presses inside this window run the kill-all, the window the TUI gives its own
// `ctrl+x ctrl+k` — a lone press only arms it, and says so.
const CONFIRM_MS = 3000;
// The clock's beat, shared by every row: one timer for the strip, not one per task.
const TICK_MS = 1000;

/**
 * Work handed off and still running, pinned above the chat.
 *
 * A turn's Agent or Bash card scrolls away as the work continues, so a sub-agent that has
 * been going for minutes looks like nothing is happening. This strip is the same fact kept
 * in view: it lists only what is running RIGHT NOW, and disappears when nothing is.
 *
 * Each row answers the three questions a glance asks: how long it has been going (the
 * harness states each task's age, see lib/harnessTasks), what it is doing at this moment
 * (the deepest running call under the task's own card), and — on a tap — everything else
 * (modals/AgentTaskModal). Stopping lives in that modal; the strip keeps only the
 * kill-all, because a row of X buttons read as a row of X buttons rather than as work.
 */
export const AiAgentStrip = memo(function AiAgentStrip({ sessionId = "", engine = "claude", onStopTask }) {
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY;
  // The harness's task set, when the engine keeps one. It is the authority: the CLI states
  // each task's status, so the strip stops inferring "still running" from a row that was
  // handed off. Engines with no task model (codex, antigravity) leave this empty and fall
  // back to the row scan — see runningAsync.
  const harnessTasks = useAiStore((s) => s.bySession[sessionId]?.harnessTasks) || EMPTY;
  // Derived on every message update, i.e. once per streamed token — but the scan reads
  // one segment's tool rows and stops at the first hit, and returns nothing when the turn
  // holds no async work at all, which is the overwhelming majority of turns.
  const running = useMemo(() => runningAsync(messages, harnessTasks), [messages, harnessTasks]);
  const [open, setOpen] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);

  // One beat for every clock on the strip, and none at all when nothing is running.
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running.length]);

  useEffect(() => () => clearTimeout(armTimer.current), []);

  const stopAll = useCallback(() => {
    if (!armed) {
      setArmed(true);
      vibrate();
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), CONFIRM_MS);
      return;
    }
    clearTimeout(armTimer.current);
    setArmed(false);
    vibrate();
    for (const r of running) if (r.taskId) onStopTask(r.taskId);
  }, [armed, running, onStopTask]);

  // Only a task the harness named can be stopped — the row-scan fallback keys on a tool
  // call id nothing on the other side answers to.
  const anyStoppable = running.some((r) => r.taskId && onStopTask);

  if (running.length === 0) return null;

  const agents = running.filter((r) => r.kind === "agent");
  const shells = running.filter((r) => r.kind === "shell");

  return (
    <div className="px-4 sm:px-6 py-1 border-b border-border-subtle/40 bg-brand-500/[0.06] shrink-0 text-xs select-none">
      {agents.length > 0 && (
        <Row icon={<Loader2 size={13} className="text-brand-500 shrink-0 animate-spin" />} tag="AGENTS"
          items={agents} messages={messages} engine={engine} now={now} onOpen={setOpen} />
      )}
      {shells.length > 0 && (
        <Row icon={<Loader2 size={13} className="text-warning shrink-0 animate-spin" />} tag="SHELLS"
          items={shells} messages={messages} engine={engine} now={now} onOpen={setOpen} />
      )}
      {anyStoppable && running.length > 1 && (
        <div className="flex justify-end pb-0.5">
          <button
            type="button"
            onClick={stopAll}
            className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
              armed ? "bg-danger/20 text-danger font-semibold" : "text-text-muted hover:text-text"
            }`}
          >
            {armed ? "Press again to stop all" : "Stop all"}
          </button>
        </div>
      )}

      {open && (
        <AgentTaskModal
          tasks={open}
          messages={messages}
          engine={engine}
          sessionId={sessionId}
          onStopTask={onStopTask}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
});

function Row({ icon, tag, items, messages, engine, now, onOpen }) {
  // The row's summary line names the tasks; the strip is a heading, not a list.
  const names = items.map((r) => r.label).join(", ");
  // The OLDEST of the group, because that is the one a reader is waiting on: "how long has
  // this been going" is a question about the whole hand-off, not about its newest arrival.
  const oldest = items.reduce((a, r) => (r.startedAt && (!a?.startedAt || r.startedAt < a.startedAt) ? r : a), null);
  const elapsed = taskElapsedMs(oldest, now);
  // The first row that can answer, not the first row: a scan-found task carries no
  // `toolUseId`, so it has no card to look under and would answer for the whole group.
  const active = items.map((r) => describeActivity(taskActivity(messages, r.toolUseId), engine)).find(Boolean);

  return (
    <div className="flex items-center gap-2 py-1 min-w-0">
      {icon}
      <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
        {tag}
      </span>
      <button
        type="button"
        onClick={() => { vibrate(); onOpen(items); }}
        title={names}
        className="flex items-center gap-2 min-w-0 flex-1 text-left hover:bg-surface-2/40 rounded transition-colors px-1"
      >
        <span className="font-mono text-[11px] text-brand-500 shrink-0 tabular-nums">
          {items.length} running
        </span>
        {/* The clock leads the detail: it is the fact that never stops moving, and the one
            an idle-looking strip exists to state. Absent for a task the harness never
            dated — a scan-found row, which prints no number rather than a made-up one. */}
        {elapsed > 0 && (
          <span className="font-mono text-[11px] text-text shrink-0 tabular-nums">{clockText(elapsed)}</span>
        )}
        <span className="text-[11px] text-text-muted truncate min-w-0">{active || names}</span>
      </button>
    </div>
  );
}

export default AiAgentStrip;
