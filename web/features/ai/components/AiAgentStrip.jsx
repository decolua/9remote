"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";
import { runningAsync } from "../lib/toolTree";
import { anchorId } from "./PaneScope";

const EMPTY = [];

// Each kind keeps the anchor its own card already carries, so a tap lands on the detail.
const ANCHOR = { agent: "agent", shell: "shell" };
// Two presses inside this window run the kill-all, the window the TUI gives its own
// `ctrl+x ctrl+k` — a lone press only arms it, and says so.
const CONFIRM_MS = 3000;

/**
 * Work handed off and still running, pinned above the chat.
 *
 * A turn's Agent or Bash card scrolls away as the work continues, so a sub-agent that has
 * been going for minutes looks like nothing is happening. This strip is the same fact kept
 * in view: it lists only what is running RIGHT NOW, and disappears when nothing is.
 * Tapping a row scrolls to that card, which still owns the detail.
 *
 * Each row carries its own stop, and "stop all" arms on a first press — the TUI's two
 * gestures, on the one surface that knows which tasks are alive.
 */
export const AiAgentStrip = memo(function AiAgentStrip({ sessionId = "", onStopTask }) {
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY;
  // The harness's task set, when the engine keeps one. It is the authority: the CLI states
  // each task's status, so the strip stops inferring "still running" from a row that was
  // handed off. Engines with no task model (codex, antigravity) leave this empty and fall
  // back to the row scan — see runningAsync.
  const harnessTasks = useAiStore((s) => s.bySession[sessionId]?.harnessTasks) || EMPTY;
  // Derived on every message update, i.e. once per streamed token — but the scan reads
  // one segment's tool rows and stops at the first hit, and returns nothing when the turn
  // holds no async work at all, which is the overwhelming majority of turns.
  const running = runningAsync(messages, harnessTasks);
  // A row carries its own `taskId` ONLY when the harness named it, and that name is the
  // one a stop addresses — the row-scan fallback keys on a tool call id nothing on the
  // other side answers to. So the control is offered per row, where a stop can land,
  // rather than per strip: an engine with no task model gets buttons that do nothing.
  const stoppable = (r) => Boolean(r.taskId && onStopTask);
  const anyStoppable = running.some(stoppable);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);

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

  if (running.length === 0) return null;

  const agents = running.filter((r) => r.kind === "agent");
  const shells = running.filter((r) => r.kind === "shell");

  return (
    <div className="px-4 sm:px-6 py-1 border-b border-border-subtle/40 bg-brand-500/[0.06] shrink-0 text-xs select-none">
      {agents.length > 0 && (
        <Row
          icon={<Loader2 size={13} className="text-brand-500 shrink-0 animate-spin" />}
          tag="AGENTS"
          count={agents.length}
          items={agents}
          sessionId={sessionId}
          stoppable={stoppable}
          onStopTask={onStopTask}
        />
      )}
      {shells.length > 0 && (
        <Row
          icon={<Loader2 size={13} className="text-warning shrink-0 animate-spin" />}
          tag="SHELLS"
          count={shells.length}
          items={shells}
          sessionId={sessionId}
          stoppable={stoppable}
          onStopTask={onStopTask}
        />
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
    </div>
  );
});

function Row({ icon, tag, count, items, sessionId, stoppable, onStopTask }) {
  const names = items.map((r) => r.label);
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length - 3;
  return (
    <div className="flex items-center gap-2 py-1 min-w-0">
      {icon}
      <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
        {tag}
      </span>
      <span className="font-mono text-[11px] text-brand-500 shrink-0">
        {count} running
      </span>
      <button
        type="button"
        onClick={() => {
          vibrate();
          // Only a MOUNTED card can be scrolled to. A long run of steps keeps its
          // earlier rows behind the "N more" bar, so the newest row may have no
          // element yet — take the first one that does.
          //
          // Looked up within THIS pane: tool ids belong to the host, and nothing keeps two
          // chats' ids apart — a bare document-wide lookup scrolled to whichever pane
          // rendered first.
          const anchor = items.find((r) => document.getElementById(anchorId(sessionId, ANCHOR[r.kind], r.id)));
          document.getElementById(anchorId(sessionId, ANCHOR[anchor?.kind], anchor?.id))
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }}
        className="text-[11px] text-text-muted truncate min-w-0 text-left hover:text-text transition-colors"
        title={names.join(", ")}
      >
        {shown}{extra > 0 ? ` +${extra}` : ""}
      </button>
      {/* One press per task, for the few the label already names. A row with no harness
          id has nothing a stop could address, and draws no button rather than one that
          silently does nothing. */}
      {items.slice(0, 3).some(stoppable) && (
        <span className="flex items-center gap-0.5 shrink-0">
          {items.slice(0, 3).map((r) =>
            stoppable(r) ? (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  vibrate();
                  onStopTask(r.taskId);
                }}
                title={`Stop ${r.label}`}
                className="text-text-muted hover:text-danger transition-colors p-0.5"
              >
                <X size={12} />
              </button>
            ) : null
          )}
        </span>
      )}
    </div>
  );
}

export default AiAgentStrip;
