import { useEffect, useRef, useState } from "preact/hooks";

// Relative time compact label (now / Nm / Nh / Nd).
const timeAgo = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Bell + badge + dropdown of sessions needing attention (done/blocked).
// Agent-only: no push/sound — surfaces finished sessions across groups.
export default function NotificationsBell({ sessions = [], allSessions = [], sessionStatus = {}, onSwitchSession }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const items = Object.entries(sessionStatus)
    .map(([id, st]) => ({ id, ...st }))
    .filter((it) => it.state === "done" || it.state === "blocked")
    .sort((a, b) => (b.since || 0) - (a.since || 0));
  const count = items.length;

  const nameOf = (id) => allSessions.find((s) => s.id === id)?.name || sessions.find((s) => s.id === id)?.name || id.slice(0, 8);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-xl transition-all duration-150 ease-out active:scale-[0.94]"
        style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
        title="Notifications"
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
          className="absolute right-0 top-full mt-1 z-50 rounded-lg shadow-lg w-72 max-h-[60vh] overflow-y-auto flex flex-col"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between px-3 py-2 flex-shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
            <span className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>Notifications</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded transition-colors"
              style={{ color: "var(--text-muted)" }}
              title="Close"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>

          {!items.length ? (
            <p className="px-3 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>No new notifications</p>
          ) : (
            <div className="flex flex-col">
              {items.map((it) => {
                const blocked = it.state === "blocked";
                return (
                  <button
                    key={it.id}
                    onClick={() => { setOpen(false); onSwitchSession?.(it.id); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors card-act"
                    title={nameOf(it.id)}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: blocked ? "var(--warning, #f59e0b)" : "var(--brand-500)" }}
                    />
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="text-sm font-medium truncate" style={{ color: "var(--text-main)" }}>{nameOf(it.id)}</span>
                      <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                        {blocked ? "Needs input" : "Replied"}
                      </span>
                    </span>
                    <span className="text-[11px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>{timeAgo(it.since)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
