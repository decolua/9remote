"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, Bot, Terminal, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { AGENT_LABELS, AGENT_ICONS } from "../constants/agentLabels";
import { statusVisual } from "@/shared/utils/statusVisual";

// Compact relative time (e.g. "now", "3m", "2h", "1d")
const timeAgo = (ts) => {
  if (!ts || !Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Notifications bell + badge + dropdown list. Shown on desktop only (hidden sm:flex);
// mobile keeps using the slide-out menu. Reads from sessionStatus (already on TerminalHeader).
export default function NotificationsBell({ sessions = [], allSessions = [], sessionStatus = {}, onSwitchSession, workspaces = [] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // All sessions surface; state from sessionStatus (idle if none). Non-idle first (by since), idle last.
  const stateRank = { working: 0, blocked: 1, done: 2, idle: 3 };
  const items = allSessions.length
    ? allSessions.map((s) => {
        const st = sessionStatus[s.id];
        return { id: s.id, state: st?.state || "idle", tool: st?.tool, since: st?.since };
      })
    : Object.entries(sessionStatus).map(([id, st]) => ({ id, ...st }));
  items.sort((a, b) => {
    const r = (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9);
    if (r !== 0) return r;
    return (b.since || 0) - (a.since || 0);
  });
  const count = items.filter((it) => it.state === "done" || it.state === "blocked").length;

  // Resolve name from the full session list so cross-group notifications show
  // their real name instead of a truncated id.
  const nameOf = (id) => allSessions.find((s) => s.id === id)?.name || sessions.find((s) => s.id === id)?.name || id.slice(0, 8);

  // Map sessionId -> workspaceId, then group name (unassigned fallback)
  const workspaceOf = (id) => allSessions.find((s) => s.id === id)?.workspaceId ?? null;
  const workspaceNameOf = (gid) => workspaces.find((g) => g.id === gid)?.name || t("workspaces.unassigned");

  // Group items: ordered by `workspaces` array, unassigned last; sessions within a group
  // follow their order in allSessions (matches SessionList), not state/since.
  const sessionOrder = new Map(allSessions.map((s, i) => [s.id, i]));
  const grouped = (() => {
    const buckets = new Map();
    for (const it of items) {
      const gid = workspaceOf(it.id);
      if (!buckets.has(gid)) buckets.set(gid, []);
      buckets.get(gid).push(it);
    }
    const bySessionOrder = (list) => [...list].sort((a, b) => {
      const ia = sessionOrder.has(a.id) ? sessionOrder.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ib = sessionOrder.has(b.id) ? sessionOrder.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });
    const ordered = [];
    for (const g of workspaces) {
      const list = buckets.get(g.id);
      if (list?.length) ordered.push({ id: g.id, name: g.name, items: bySessionOrder(list) });
    }
    const unassigned = buckets.get(null);
    if (unassigned?.length) ordered.push({ id: null, name: t("workspaces.unassigned"), items: bySessionOrder(unassigned) });
    return ordered;
  })();

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handlePick = (id) => {
    setOpen(false);
    onSwitchSession?.(id);
  };

  // Delayed close so moving the pointer across the gap to the popup doesn't dismiss it
  const closeTimer = useRef(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={wrapRef}
      className="relative hidden sm:flex flex-shrink-0"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
        title={t("notifications.title")}
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute top-0 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full pt-2 z-[70] flex flex-col">
        <div className="bg-surface-2 border border-border-subtle rounded-brand-lg shadow-lg w-72 max-h-[60vh] overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle flex-shrink-0">
            <span className="text-sm font-semibold">{t("notifications.title")}</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1 text-text-muted hover:text-text rounded transition-colors"
              title={t("common.close")}
            >
              <X size={14} />
            </button>
          </div>

          {!items.length ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">{t("notifications.empty")}</p>
          ) : (
            <div className="flex flex-col">
              {grouped.map((grp) => (
                <div key={grp.id ?? "unassigned"} className="flex flex-col">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-text-muted" />
                    <span className="truncate">{grp.name}</span>
                  </div>
                  {grp.items.map((it) => {
                    const v = statusVisual(it.state);
                    const isIdle = it.state === "idle";
                    const stateLabel = it.state === "working"
                      ? t("common.statusWorking")
                      : it.state === "blocked"
                        ? t("notifications.needsInput")
                        : isIdle
                          ? t("common.statusIdle")
                          : t("notifications.replied");
                    return (
                      <button
                        key={it.id}
                        onClick={() => handlePick(it.id)}
                        className={`w-full flex items-center gap-2 px-3 py-1 hover:bg-surface-3 text-left transition-colors ${isIdle ? "opacity-50" : ""}`}
                        title={nameOf(it.id)}
                      >
                        {isIdle ? (
                          <span className="w-2 h-2 rounded-full flex-shrink-0 border border-text-muted/60" />
                        ) : (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                        )}
                        {AGENT_ICONS[it.tool] && !isIdle ? (
                          <img src={AGENT_ICONS[it.tool]} alt={it.tool} className="w-5 h-5 flex-shrink-0" />
                        ) : (
                          <Terminal size={18} className="text-text-muted flex-shrink-0" />
                        )}
                        <span className="flex-1 min-w-0 flex flex-col">
                          <span className="text-sm font-medium truncate">{nameOf(it.id)}</span>
                          <span className="text-xs text-text-muted truncate">
                            {AGENT_LABELS[it.tool] || t("notifications.agent")}
                            {" · "}
                            {stateLabel}
                          </span>
                        </span>
                        <span className="text-[11px] text-text-muted flex-shrink-0">{timeAgo(it.since)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
