"use client";

import { memo } from "react";
import { Users, Terminal } from "@/shared/components/ui/Icon";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";
import { runningAsync } from "../lib/toolTree";
import { anchorId } from "./PaneScope";

const EMPTY = [];

// Each kind keeps the anchor its own card already carries, so a tap lands on the detail.
const ANCHOR = { agent: "agent", shell: "shell" };

/**
 * Work handed off and still running, pinned above the chat.
 *
 * A turn's Agent or Bash card scrolls away as the work continues, so a sub-agent that has
 * been going for minutes looks like nothing is happening. This strip is the same fact kept
 * in view: it lists only what is running RIGHT NOW, and disappears when nothing is.
 * Tapping a row scrolls to that card, which still owns the detail.
 */
export const AiAgentStrip = memo(function AiAgentStrip({ sessionId = "" }) {
  const messages = useAiStore((s) => s.bySession[sessionId]?.messages) || EMPTY;
  // Derived on every message update, i.e. once per streamed token — but the scan reads
  // one segment's tool rows and stops at the first hit, and returns nothing when the turn
  // holds no async work at all, which is the overwhelming majority of turns.
  const running = runningAsync(messages);
  if (running.length === 0) return null;

  const agents = running.filter((r) => r.kind === "agent");
  const shells = running.filter((r) => r.kind === "shell");

  return (
    <div className="px-4 sm:px-6 py-1 border-b border-border-subtle/40 bg-brand-500/[0.06] shrink-0 text-xs select-none">
      {agents.length > 0 && (
        <Row
          icon={<Users size={13} className="text-brand-500 shrink-0 animate-pulse" />}
          tag="AGENTS"
          count={agents.length}
          items={agents}
          sessionId={sessionId}
        />
      )}
      {shells.length > 0 && (
        <Row
          icon={<Terminal size={13} className="text-warning shrink-0 animate-pulse" />}
          tag="SHELLS"
          count={shells.length}
          items={shells}
          sessionId={sessionId}
        />
      )}
    </div>
  );
});

function Row({ icon, tag, count, items, sessionId }) {
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
    </div>
  );
}

export default AiAgentStrip;
