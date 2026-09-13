"use client";

import { memo, useState, useEffect, useMemo, useCallback } from "react";
import { History, Search, CornerDownLeft, RefreshCw, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useConnectionStore } from "@/shared/stores/connectionStore";
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
  onClose,
  onResume
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    const bus = useConnectionStore.getState().bus;
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
      <div className="p-3 border-b border-border-subtle bg-bg shrink-0">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-brand bg-surface border border-border-subtle focus-within:border-brand-500">
          <Search size={14} className="text-text-muted shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
            className="w-full bg-transparent text-xs text-text placeholder-text-muted focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={load}
            className="text-text-muted hover:text-text shrink-0"
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
          filtered.map((row) => (
            <div
              key={`${row.agent}:${row.sessionId}`}
              onClick={() => handlePick(row)}
              className="modal-row"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-text truncate">
                  {row.title || "Untitled conversation"}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-text-subtle">
                  <span className="truncate max-w-[160px]">{row.sessionId}</span>
                  {row.updatedAt ? <><span>·</span><span>{relativeAge(row.updatedAt)}</span></> : null}
                </div>
              </div>
              <span className="modal-row-acts text-[11px] text-brand-500 items-center gap-1">
                <span>Resume</span>
                <CornerDownLeft size={11} />
              </span>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
});
