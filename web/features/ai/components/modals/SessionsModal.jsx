"use client";

import { memo, useState, useEffect, useMemo, useCallback } from "react";
import { History, Search, RefreshCw, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { OPEN_SESSION_EVENT } from "@/features/terminal/constants/terminalConfig";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { ModalShell } from "./ModalShell";

function relativeAge(ms) {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Past conversations the CLIs kept for this directory. Reuses the terminal's
// agent-history bus so both surfaces read the same scan.
export const SessionsModal = memo(function SessionsModal({
  engine = "claude",
  workspacePath = "",
  bus = null,
  onClose,
  onResume
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    if (!bus?.emit || !workspacePath) {
      setSessions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    bus.emit("getAgentSessions", { cwd: workspacePath }, (res) => {
      setSessions(Array.isArray(res?.sessions) ? res.sessions : []);
      setLoading(false);
    });
  }, [workspacePath]);

  useEffect(() => { load(); }, [load]);

  // Only this engine's own conversations — resuming a Codex thread from the
  // Claude UI would hand the CLI an id it cannot read.
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return sessions
      .filter((s) => !engine || s.agent === engine)
      .filter((s) => !q || (s.title || "").toLowerCase().includes(q) || (s.sessionId || "").toLowerCase().includes(q));
  }, [sessions, engine, query]);

  const handlePick = (row) => {
    vibrate();
    onResume?.(row);
    onClose?.();
  };

  return (
    <ModalShell
      icon={<History size={14} />}
      iconClass="bg-sky-500/15 text-sky-400"
      title="Resume a session"
      subtitle={`Past ${engine} conversations in this project`}
      maxWidth="max-w-xl"
      onClose={onClose}
    >
      {/* No fill and no strip of its own: the panel behind is already a surface, and a
          second one nested in it read as a darker band across the top of the modal. */}
      <div className="px-4 py-2.5 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2 focus-within:text-text text-text-muted">
          <Search size={14} className="shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
            className="w-full bg-transparent text-xs text-text placeholder-text-muted/70 focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={load}
            className="hover:text-text shrink-0"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>Scanning conversations...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
            <History size={32} className="opacity-50" />
            <span className="text-sm">
              {sessions.length === 0 ? "No past conversations found for this project." : `No sessions matching "${query}".`}
            </span>
          </div>
        ) : (
          filtered.map((row) => {
            // The host tags the row a terminal is already running. Resuming it would
            // open a second copy of one conversation, so the row marks it and picks
            // that terminal instead.
            const isOpen = !!row.openSessionId;
            return (
              <div
                key={`${row.agent}:${row.sessionId}`}
                onClick={() => {
                  vibrate();
                  if (isOpen) {
                    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: row.openSessionId } }));
                    onClose?.();
                    return;
                  }
                  handlePick(row);
                }}
                className="modal-row"
                title={row.sessionId}
              >
                {/* The CLI's own mark, the one thing that tells Claude from Codex at a
                    glance. The session id it replaced was a 36-char string nobody picks by. */}
                <img
                  src={agentIconUrl(row.mode === "ui" ? `${row.agent}-ui` : row.agent)}
                  alt={row.agent}
                  className={`shrink-0 ${AGENT_ICON_CLS} ${isOpen ? "" : "opacity-50"}`}
                  style={{ width: 14, height: 14 }}
                />
                {/* Already running reads as the brighter row, same as the sidebar's
                    history — no badge, no colour, the contrast says it. */}
                <span className={`flex-1 min-w-0 truncate text-xs ${isOpen ? "text-text font-medium" : "text-text-muted"}`}>
                  {row.title || "Untitled conversation"}
                </span>
                {row.updatedAt ? (
                  <span className="shrink-0 text-[10px] font-mono text-text-subtle tabular-nums">
                    {relativeAge(row.updatedAt)}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
});
