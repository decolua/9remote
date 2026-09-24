"use client";

import { useEffect, useState, useMemo } from "react";
import { X, History, Trash2, Search, Play } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import ConfirmDialog from "./ConfirmDialog";

function relativeAge(ms, t) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return t("agentHistory.minutesAgo", { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("agentHistory.hoursAgo", { n: hours });
  return t("agentHistory.daysAgo", { n: Math.round(hours / 24) });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AgentHistoryModal({
  isOpen,
  onClose,
  busRef,
  cwd,
  scope = "",
  onResume,
  onSelectSession,
  liveSessionIds,
  activeSessionId,
  connected = true
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [deletingSession, setDeletingSession] = useState(null);
  // Same path on two machines is two histories — key through the host scope.
  const historyKey = scope ? `${scope}|${cwd}` : cwd;

  const rawSessions = useTerminalStore((s) => (cwd ? s.agentHistory[historyKey]?.sessions : null));
  const sessions = useMemo(() => rawSessions || [], [rawSessions]);

  useEffect(() => {
    if (!isOpen) return;
    document.activeElement?.blur?.();
    const handleEscape = (e) => {
      if (e.key === "Escape" && !deletingSession) onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, deletingSession]);

  const agentTypes = useMemo(() => {
    const set = new Set();
    for (const s of sessions) {
      if (s.agent) set.add(s.agent);
    }
    return Array.from(set);
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (selectedAgent !== "all" && s.agent !== selectedAgent) return false;
      if (!q) return true;
      const title = (s.title || "").toLowerCase();
      const id = (s.sessionId || "").toLowerCase();
      const agent = (s.agent || "").toLowerCase();
      return title.includes(q) || id.includes(q) || agent.includes(q);
    });
  }, [sessions, query, selectedAgent]);

  if (!isOpen) return null;

  const handleResume = (row, openId) => {
    vibrate();
    if (openId) onSelectSession?.(openId);
    else onResume?.(row);
    onClose();
  };

  const handleConfirmDelete = () => {
    if (!deletingSession) return;
    const { agent, sessionId } = deletingSession;
    vibrate();

    // Optimistically remove from store
    const nextSessions = sessions.filter((s) => !(s.agent === agent && s.sessionId === sessionId));
    useTerminalStore.getState().setAgentHistory(historyKey, nextSessions);

    busRef?.current?.emit("deleteAgentSession", { agent, sessionId, cwd }, (res) => {
      if (!res?.success) {
        // Re-fetch on error
        busRef?.current?.emit("getAgentSessions", { cwd }, (r) => {
          if (Array.isArray(r?.sessions)) useTerminalStore.getState().setAgentHistory(historyKey, r.sessions);
        });
      }
    });

    setDeletingSession(null);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200 touch-none"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-xl w-full max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-200 bg-surface border border-border rounded-brand-lg overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <History size={17} className="text-text-muted" />
            <h3 className="text-base font-semibold text-text">{t("agentHistory.title")}</h3>
            <span className="px-2 py-0.5 text-xs rounded-full bg-surface-2 text-text-subtle font-mono">
              {sessions.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        {/* Search & Filters */}
        <div className="p-3 border-b border-border-subtle flex flex-col gap-2 bg-surface-1/50 flex-shrink-0">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-text-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("agentHistory.searchPlaceholder")}
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-surface-2 border border-border-subtle rounded-brand text-text placeholder-text-muted outline-none focus:border-text-muted/40 focus:ring-1 focus:ring-text-muted/20 transition-all"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2.5 p-0.5 text-text-muted hover:text-text rounded transition-colors"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {agentTypes.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
              <button
                onClick={() => setSelectedAgent("all")}
                className={`px-2.5 py-1 text-xs rounded-brand transition-colors whitespace-nowrap ${
                  selectedAgent === "all"
                    ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                    : "bg-surface-2 text-text-muted hover:text-text"
                }`}
              >
                {t("agentHistory.allAgents")}
              </button>
              {agentTypes.map((ag) => (
                <button
                  key={ag}
                  onClick={() => setSelectedAgent(ag)}
                  className={`px-2.5 py-1 text-xs rounded-brand transition-colors flex items-center gap-1.5 whitespace-nowrap capitalize ${
                    selectedAgent === ag
                      ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                      : "bg-surface-2 text-text-muted hover:text-text"
                  }`}
                >
                  <img src={agentIconUrl(ag)} alt="" className={`w-3.5 h-3.5 ${AGENT_ICON_CLS}`} />
                  <span>{ag}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sessions list */}
        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-text-muted text-sm gap-2">
              <History size={32} className="opacity-40" />
              <span>{query ? t("agentHistory.noResults") : t("agentHistory.empty")}</span>
            </div>
          ) : (
            filtered.map((row) => {
              const openId = row.openSessionId && liveSessionIds?.has(row.openSessionId)
                ? row.openSessionId
                : null;
              const isActive = !!openId && openId === activeSessionId;
              const title = row.title || t("agentHistory.untitled");

              return (
                <div
                  key={`${row.agent}:${row.sessionId}`}
                  className={`group flex items-center gap-2.5 px-3 py-2 rounded-brand transition-colors ${
                    isActive ? "bg-surface-2 border border-border-subtle" : "hover:bg-surface-2"
                  }`}
                >
                  <img
                    src={agentIconUrl(row.agent)}
                    alt={row.agent}
                    className={`w-5 h-5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`}
                  />
                  <div
                    onClick={() => handleResume(row, openId)}
                    className="flex-1 min-w-0 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs truncate font-medium ${openId ? "text-emerald-400" : "text-text"}`}>
                        {title}
                      </span>
                      {openId && (
                        <span className="px-1.5 py-0.2 text-[10px] rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex-shrink-0">
                          {t("agentHistory.openNow")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-subtle">
                      <span className="capitalize">{row.agent}</span>
                      <span>•</span>
                      <span className="tabular-nums">{relativeAge(row.updatedAt, t)}</span>
                      {row.size > 0 && (
                        <>
                          <span>•</span>
                          <span className="tabular-nums font-mono text-[10px] opacity-75">{formatBytes(row.size)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleResume(row, openId)}
                      disabled={!connected}
                      className="p-1.5 text-text-muted hover:text-text hover:bg-surface-3 rounded-brand transition-colors"
                      title={openId ? t("agentHistory.openNow") : t("common.confirm")}
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => setDeletingSession(row)}
                      disabled={!connected || !!openId}
                      className="p-1.5 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-brand transition-colors disabled:opacity-30 disabled:hover:text-text-muted disabled:hover:bg-transparent"
                      title={openId ? t("agentHistory.openNow") : t("agentHistory.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {deletingSession && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => setDeletingSession(null)}
          onConfirm={handleConfirmDelete}
          title={t("agentHistory.deleteTitle")}
          message={t("agentHistory.deleteMessage", { title: deletingSession.title || t("agentHistory.untitled") })}
        />
      )}
    </div>
  );
}
