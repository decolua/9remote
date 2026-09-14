"use client";

import { memo } from "react";
import { Users } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";
import { runningAgents } from "../lib/toolTree";

const EMPTY = [];

/**
 * The running sub-agents, pinned above the chat.
 *
 * A turn's Agent cards scroll away as the work continues, so a sub-agent that has been
 * going for minutes looks like nothing is happening. This strip is the same fact kept
 * in view: it lists only what is running RIGHT NOW, and disappears when nothing is.
 * Tapping a row scrolls to that agent's own card, which still owns the detail.
 */
export const AiAgentStrip = memo(function AiAgentStrip({ sessionId = "" }) {
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY;
  // Derived on every message update, i.e. once per streamed token — but the scan reads
  // one segment's tool rows and stops at the first hit, and returns null when the turn
  // holds no sub-agent at all, which is the overwhelming majority of turns.
  const running = runningAgents(messages);
  if (running.length === 0) return null;

  const names = running.map((r) => r.label);
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length - 3;

  return (
    <div className="px-4 sm:px-6 py-1 border-b border-border-subtle/40 bg-brand-500/[0.06] shrink-0 text-xs select-none">
      <div className="flex items-center gap-2 py-1 min-w-0">
        <Users size={13} className="text-brand-500 shrink-0 animate-pulse" />
        <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
          AGENTS
        </span>
        <span className="font-mono text-[11px] text-brand-500 shrink-0">
          {running.length} running
        </span>
        <button
          type="button"
          onClick={() => {
            vibrate();
            // Only a MOUNTED card can be scrolled to. A long run of steps keeps its
            // earlier rows behind the "N more" bar, so the newest running agent may
            // have no element yet — take the first one that does.
            const target = running.find((r) => document.getElementById(`agent-${r.id}`));
            document.getElementById(`agent-${target?.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          }}
          className="text-[11px] text-text-muted truncate min-w-0 text-left hover:text-text transition-colors"
          title={names.join(", ")}
        >
          {shown}{extra > 0 ? ` +${extra}` : ""}
        </button>
      </div>
    </div>
  );
});

export default AiAgentStrip;
