"use client";

// Dev-only in-app log viewer — mobile browsers can't open DevTools console, so on
// dev deploys (dev.*) this surfaces the termLog ring buffer as an overlay. Hidden
// in production (isTermLogEnabled() === false → zero cost).
import { useEffect, useRef, useState } from "react";
import { X, Trash2, Copy } from "@/shared/components/ui/Icon";
import { getTermLog, onTermLog, clearTermLog, isTermLogEnabled } from "@/shared/utils/termLog";

const CAT_COLORS = {
  recv: "text-green-400",
  join: "text-blue-400",
  reconnect: "text-yellow-400",
  switch: "text-purple-400",
  resize: "text-cyan-400",
  send: "text-orange-400",
};

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export default function DevTermLog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(() => getTermLog());
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef(null);
  // Draggable button position — persisted so it stays where the user drops it.
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 8, y: 8 };
    try {
      const saved = JSON.parse(localStorage.getItem("9remote:termLogBtn") || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    } catch {}
    return { x: 8, y: 8 };
  });
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });

  const onPointerDown = (e) => {
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    const W = window.innerWidth, H = window.innerHeight;
    const nx = Math.max(4, Math.min(W - 44, d.origX + dx));
    const ny = Math.max(4, Math.min(H - 44, d.origY + dy));
    setPos({ x: nx, y: ny });
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    d.dragging = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!d.moved) {
      setOpen((v) => !v);
    } else {
      try { localStorage.setItem("9remote:termLogBtn", JSON.stringify(pos)); } catch {}
    }
  };

  useEffect(() => {
    if (!isTermLogEnabled()) return;
    return onTermLog(() => { if (!paused) setEntries([...getTermLog()]); });
  }, [paused]);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, open]);

  if (!isTermLogEnabled()) return null;

  const filtered = filter
    ? entries.filter((e) => e.category.includes(filter) || e.msg.includes(filter))
    : entries;

  const handleCopy = async () => {
    const text = filtered.map((e) => `${fmtTime(e.ts)} ${e.category} ${e.msg}`).join("\n");
    try { await navigator.clipboard?.writeText(text); } catch {}
  };

  return (
    <>
      {/* Floating toggle — draggable (touch-drag to move, tap to toggle). Persists position. */}
      <button
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="fixed z-[80] px-1.5 py-1 rounded-full bg-surface-2/90 backdrop-blur-sm shadow-md text-text border border-border-subtle touch-none select-none cursor-grab active:cursor-grabbing"
        title="Dev log (drag to move)"
      >
        <span className="text-[10px] font-bold leading-none">{entries.length}</span>
      </button>

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-[79] flex flex-col pb-safe" style={{ height: "55vh" }}>
          <div className="bg-surface-2/95 backdrop-blur-sm border-t border-border-subtle rounded-t-xl shadow-2xl flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle flex-shrink-0">
              <span className="text-xs font-semibold text-text">termLog</span>
              <span className="text-[10px] text-text-muted">({filtered.length}/{entries.length})</span>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="flex-1 min-w-0 text-[11px] bg-surface px-2 py-0.5 rounded border border-border-subtle text-text"
              />
              <button onClick={() => setPaused((v) => !v)} className="p-1 text-text-muted hover:text-text text-[10px]" title={paused ? "Resume" : "Pause"}>
                {paused ? "▶" : "⏸"}
              </button>
              <button onClick={handleCopy} className="p-1 text-text-muted hover:text-text" title={`Copy ${filtered.length} rows`}>
                <Copy size={13} />
              </button>
              <button onClick={() => { clearTermLog(); setEntries([]); }} className="p-1 text-text-muted hover:text-text" title="Clear">
                <Trash2 size={13} />
              </button>
              <button onClick={() => setOpen(false)} className="p-1 text-text-muted hover:text-text" title="Close">
                <X size={14} />
              </button>
            </div>
            {/* Log list */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-auto px-2 py-1 font-mono text-[10px] leading-tight">
              {filtered.length === 0 ? (
                <p className="text-text-muted text-center py-4">No logs yet</p>
              ) : filtered.map((e, i) => (
                <div key={i} className="flex gap-1.5 py-0.5 hover:bg-surface rounded px-1">
                  <span className="text-text-muted flex-shrink-0">{fmtTime(e.ts)}</span>
                  <span className={`flex-shrink-0 font-bold ${CAT_COLORS[e.category] || "text-text"}`}>{e.category}</span>
                  <span className="text-text break-all whitespace-pre-wrap">{e.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
