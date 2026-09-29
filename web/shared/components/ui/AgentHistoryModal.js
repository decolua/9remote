"use client";

import { useEffect, useState, useMemo } from "react";
import { X, History, Trash2, Search, GitFork } from "@/shared/components/ui/Icon";
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

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

// Split a snippet on the query that fetched it; matched spans render as <mark>
// (weight + tint, never color alone). q is the SENT query, not the draft.
function highlightQuery(text, q) {
  if (!q) return text;
  const parts = String(text).split(new RegExp(`(${q.replace(ESCAPE_RE, "\\$&")})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={i} className="bg-transparent text-text font-semibold px-0">{part}</mark>
      : part
  );
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
  const [globalRows, setGlobalRows] = useState([]);
  const [activeQuery, setActiveQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  // Same path on two machines is two histories — key through the host scope.
  const historyKey = scope ? `${scope}|${cwd}` : cwd;

  const rawSessions = useTerminalStore((s) => (cwd ? s.agentHistory[historyKey]?.sessions : null));
  const sessions = useMemo(() => rawSessions || [], [rawSessions]);

  // 3+ chars widens the box's local filter into a host-wide content search
  // across every directory's transcripts; rows land in the same list below.
  // Inactive states are derived at render — the effect only sets state async.
  const searchActive = isOpen && connected && query.trim().length >= 3;
  useEffect(() => {
    if (!searchActive) return;
    const q = query.trim();
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      busRef?.current?.emit("searchAgentSessions", { query: q }, (res) => {
        if (stale) return;
        setSearching(false);
        setSearchTruncated(!!res?.truncated);
        setGlobalRows(Array.isArray(res?.sessions) ? res.sessions : []);
        // Snippets/highlights answer the query that produced them, not the draft.
        setActiveQuery(q);
      });
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [query, searchActive, busRef]);

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

  const rowMatches = (s, q) => {
    const title = (s.title || "").toLowerCase();
    const id = (s.sessionId || "").toLowerCase();
    const agent = (s.agent || "").toLowerCase();
    return title.includes(q) || id.includes(q) || agent.includes(q);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    const seen = new Set();
    // Content hits for conversations already in this list — attach the snippet
    // so a title-matching local row still shows WHY it matched.
    const snippetByKey = new Map();
    for (const s of (searchActive ? globalRows : [])) {
      if (s.snippet) snippetByKey.set(`${s.agent}:${s.sessionId}`, s.snippet);
    }
    for (const s of sessions) {
      if (selectedAgent !== "all" && s.agent !== selectedAgent) continue;
      if (!q || rowMatches(s, q)) {
        const snippet = snippetByKey.get(`${s.agent}:${s.sessionId}`);
        out.push(snippet ? { ...s, snippet } : s);
        seen.add(`${s.agent}:${s.sessionId}`);
      }
    }
    for (const s of (searchActive ? globalRows : [])) {
      if (seen.has(`${s.agent}:${s.sessionId}`)) continue;
      if (selectedAgent !== "all" && s.agent !== selectedAgent) continue;
      // Foreign marks a search hit from outside this list's store — its delete
      // would miss. Local rows (worktree branch rows included) stay deletable.
      out.push({ ...s, foreign: true });
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [sessions, globalRows, searchActive, query, selectedAgent]);

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
      <div className="relative card-elev max-w-xl w-full max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-200 overflow-hidden">
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
        <div className="p-3 border-b border-border-subtle flex flex-col gap-2.5 bg-surface-2/30 flex-shrink-0">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-text-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("agentHistory.searchPlaceholder")}
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-surface-2 border border-border-subtle rounded-brand text-text placeholder-text-muted outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/20 transition-all"
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

          {/* Fixed-height slot: the searching/truncated line comes and goes
              without ever pushing the list up or down. */}
          <div className="h-4 px-1 text-[11px] leading-4 text-text-subtle">
            {searchActive && (searching
              ? t("agentHistory.searchingAll")
              : searchTruncated ? t("agentHistory.searchTruncated") : null)}
          </div>

          {agentTypes.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              <button
                onClick={() => setSelectedAgent("all")}
                className={`shrink-0 h-7 px-3.5 text-xs rounded-brand transition-colors whitespace-nowrap flex items-center justify-center ${
                  selectedAgent === "all"
                    ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                    : "bg-surface-2/60 text-text-muted hover:text-text hover:bg-surface-2 border border-transparent"
                }`}
              >
                {t("agentHistory.allAgents")}
              </button>
              {agentTypes.map((ag) => (
                <button
                  key={ag}
                  onClick={() => setSelectedAgent(ag)}
                  className={`shrink-0 h-7 px-3.5 text-xs rounded-brand transition-colors flex items-center gap-2 whitespace-nowrap capitalize ${
                    selectedAgent === ag
                      ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                      : "bg-surface-2/60 text-text-muted hover:text-text hover:bg-surface-2 border border-transparent"
                  }`}
                >
                  <img src={agentIconUrl(ag)} alt="" className={`w-3.5 h-3.5 ${AGENT_ICON_CLS}`} />
                  <span>{ag}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sessions list — fixed height so result count never resizes the modal
            while typing; results swap inside the scroll area instead. */}
        <div className="h-[55vh] min-h-0 overflow-y-auto modal-scrollable p-2 space-y-1">
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
              const title = row.title || t("agentHistory.untitled");
              // Search hit from outside this list's store: no delete, show its path.
              const foreign = !!row.foreign;

              return (
                <div
                  key={`${row.agent}:${row.sessionId}`}
                  onClick={() => handleResume(row, openId)}
                  className="group flex items-center gap-2.5 px-3 py-2 rounded-brand cursor-pointer transition-colors hover:bg-surface-2"
                >
                  <img
                    src={agentIconUrl(row.agent)}
                    alt={row.agent}
                    className={`w-5 h-5 flex-shrink-0 object-contain ${AGENT_ICON_CLS} ${openId ? "" : "opacity-70"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs truncate ${openId ? "text-text font-medium" : "text-text-muted"}`}>
                        {title}
                      </span>
                      {openId && (
                        <span className="px-2 py-0.5 text-[10px] leading-none rounded bg-success/15 text-success border border-success/25 flex-shrink-0 font-medium">
                          {t("agentHistory.openNow")}
                        </span>
                      )}
                    </div>
                    {row.snippet && (
                      <div className="mt-0.5 text-[11px] leading-snug text-text-subtle line-clamp-2">
                        {highlightQuery(row.snippet, activeQuery)}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-text-subtle min-w-0">
                      {foreign && row.cwd && row.cwd !== cwd && (
                        <>
                          <span className="truncate min-w-0 max-w-[45%] font-mono" title={row.cwd}>
                            {row.cwd}
                          </span>
                          <span>•</span>
                        </>
                      )}
                      {/* Worktree rows name their branch here; main-checkout rows stay bare */}
                      {row.branch && row.branch !== "main" && row.branch !== "master" && (
                        <>
                          <span className="flex items-center gap-0.5 min-w-0 max-w-[45%]" title={row.branch}>
                            <GitFork size={9} className="text-brand-500 shrink-0" />
                            <span className="truncate">{row.branch}</span>
                          </span>
                          <span>•</span>
                        </>
                      )}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingSession(row);
                      }}
                      disabled={!connected || !!openId || !!foreign}
                      className={`p-1.5 text-text-muted hover:text-danger hover:bg-danger/10 rounded-brand transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 ${
                        openId || foreign ? "invisible pointer-events-none" : ""
                      }`}
                      title={t("agentHistory.delete")}
                      aria-label={t("agentHistory.delete")}
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
