import { useEffect, useRef, useState } from "preact/hooks";
import { useI18n } from "../i18n";
import { statusVisual, dotClassName } from "../lib/statusVisual";
import { AGENT_LABELS, AGENT_ICONS } from "../lib/agentLabels";

// Relative time compact label (now / Nm / Nh / Nd).
const timeAgo = (ts) => {
  if (!ts || !Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Bell + badge + dropdown of all sessions (hover-to-open on desktop).
// Grouped by session group; non-idle first. Mirrors web NotificationsBell.
export default function NotificationsBell({ sessions = [], allSessions = [], sessionStatus = {}, groups = [], onSwitchSession }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const closeTimer = useRef(null);

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => cancelClose(), []);

  const list = allSessions.length ? allSessions : sessions;
  const stateRank = { working: 0, blocked: 1, done: 2, idle: 3 };
  const items = list.map((s) => {
    const st = sessionStatus[s.id];
    return { id: s.id, name: s.name, groupId: s.groupId ?? null, state: st?.state || "idle", tool: st?.tool, since: st?.since };
  });
  items.sort((a, b) => {
    const r = (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9);
    if (r !== 0) return r;
    return (b.since || 0) - (a.since || 0);
  });
  const count = items.filter((it) => it.state === "done" || it.state === "blocked").length;

  // Group items: ordered by `groups`, ungrouped last; within a group keep list order.
  const sessionOrder = new Map(list.map((s, i) => [s.id, i]));
  const groupNameOf = (gid) => groups.find((g) => g.id === gid)?.name || t("groups.ungrouped");
  const grouped = (() => {
    const buckets = new Map();
    for (const it of items) {
      if (!buckets.has(it.groupId)) buckets.set(it.groupId, []);
      buckets.get(it.groupId).push(it);
    }
    const byOrder = (arr) => [...arr].sort((a, b) => (sessionOrder.get(a.id) ?? Infinity) - (sessionOrder.get(b.id) ?? Infinity));
    const ordered = [];
    for (const g of groups) {
      const arr = buckets.get(g.id);
      if (arr?.length) ordered.push({ id: g.id, name: g.name, items: byOrder(arr) });
    }
    const ungrouped = buckets.get(null);
    if (ungrouped?.length) ordered.push({ id: null, name: t("groups.ungrouped"), items: byOrder(ungrouped) });
    return ordered;
  })();

  // Outside click / Escape close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handlePick = (id) => { setOpen(false); onSwitchSession?.(id); };

  return (
    <div
      ref={wrapRef}
      className="relative flex-shrink-0"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-xl transition-all duration-150 ease-out active:scale-[0.94]"
        style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
        title={t("notifications.title")}
      >
        <span className="material-symbols-outlined text-[18px]">notifications</span>
        {count > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
            style={{ background: "var(--brand-500)" }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-[70] rounded-lg shadow-lg w-72 max-h-[60vh] overflow-y-auto flex flex-col"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>{t("notifications.title")}</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded transition-colors"
              style={{ color: "var(--text-muted)" }}
              title={t("common.close")}
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>

          {!items.length ? (
            <p className="px-3 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>{t("notifications.empty")}</p>
          ) : (
            <div className="flex flex-col">
              {grouped.map((grp) => (
                <div key={grp.id ?? "ungrouped"} className="flex flex-col">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                    <span className="w-1 h-1 rounded-full" style={{ background: "var(--text-muted)" }} />
                    <span className="truncate">{grp.name}</span>
                  </div>
                  {grp.items.map((it) => {
                    const v = statusVisual(it.state);
                    const isIdle = it.state === "idle";
                    const name = it.name || it.id.slice(0, 8);
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
                        className={`w-full flex items-center gap-2 px-3 py-1 text-left transition-colors card-act ${isIdle ? "opacity-50" : ""}`}
                        title={name}
                      >
                        {isIdle ? (
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ border: "1px solid var(--text-muted)" }} />
                        ) : (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClassName(it.state)}`} style={{ background: v.dot }} />
                        )}
                        {AGENT_ICONS[it.tool] && !isIdle ? (
                          <img src={AGENT_ICONS[it.tool]} alt={it.tool} className="w-5 h-5 flex-shrink-0" />
                        ) : (
                          <span className="material-symbols-outlined text-[20px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>terminal</span>
                        )}
                        <span className="flex-1 min-w-0 flex flex-col">
                          <span className="text-sm font-medium truncate" style={{ color: "var(--text-main)" }}>{name}</span>
                          <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                            {AGENT_LABELS[it.tool] || t("notifications.agent")} · {stateLabel}
                          </span>
                        </span>
                        <span className="text-[11px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>{timeAgo(it.since)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
