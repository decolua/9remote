"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { X, Terminal, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { BOTTOM_PANEL_MIN_HEIGHT, BOTTOM_PANEL_MAX_HEIGHT } from "../constants/fileExplorer.js";
import TerminalPane from "@/features/terminal/components/TerminalPane";

export default function BottomPanel({
  height,
  onResize,
  onClose,
  bus,
  connected,
  sessions = [],
  onCreateSession,
  onDeleteSession,
  onRenameSession
}) {
  const [activeId, setActiveId] = useState(sessions[0]?.id || null);
  const containerRef = useRef(null);
  const createdRef = useRef(false);

  // Sync activeId when sessions change
  useEffect(() => {
    if (sessions.length === 0) return;
    if (!activeId || !sessions.find(s => s.id === activeId)) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  // Auto-create first session if none
  useEffect(() => {
    if (sessions.length === 0 && onCreateSession && !createdRef.current) {
      createdRef.current = true;
      onCreateSession((newId) => setActiveId(newId));
    }
    if (sessions.length > 0) createdRef.current = false;
  }, [sessions.length, onCreateSession]);

  const handleCreate = useCallback(() => {
    vibrate();
    onCreateSession?.((newId) => setActiveId(newId));
  }, [onCreateSession]);

  const handleDelete = useCallback((e, id) => {
    e.stopPropagation();
    vibrate();
    onDeleteSession?.(id);
  }, [onDeleteSession]);

  // Vertical drag-resize
  const startResize = useCallback((e) => {
    e.preventDefault();
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const onMove = (ev) => {
      if (ev.buttons === 0) {
        onUp();
        return;
      }
      const pct = ((rect.bottom - ev.clientY) / rect.height) * 100;
      const clamped = Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(BOTTOM_PANEL_MAX_HEIGHT, pct));
      onResize(clamped);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
  }, [onResize]);

  return (
    <div
      ref={containerRef}
      className="bg-bg border-t border-border flex flex-col flex-shrink-0"
      style={{ height: `${height}%` }}
    >
      <div
        onMouseDown={startResize}
        className="h-1 cursor-row-resize bg-border hover:bg-surface-3 transition-colors -mt-1 relative z-10"
      />
      <div className="bg-surface border-b border-border flex items-center px-2 flex-shrink-0 overflow-x-auto">
        <div className="flex items-center text-text-muted text-xs uppercase tracking-wider px-2 py-1.5 mr-1">
          <Terminal size={12} className="mr-1" />
          Terminal
        </div>
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              onClick={() => { vibrate(); setActiveId(s.id); }}
              className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors max-w-[160px] ${
                active ? "text-text bg-bg border-t-2 border-text-muted" : "text-text-muted hover:text-text"
              }`}
              title={s.name}
            >
              <span className="truncate">{s.name}</span>
              <X
                size={12}
                onClick={(e) => handleDelete(e, s.id)}
                className="opacity-0 group-hover:opacity-100 hover:text-danger flex-shrink-0"
              />
            </button>
          );
        })}
        <button
          onClick={handleCreate}
          className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-2 ml-1 flex-shrink-0"
          title="New Terminal"
        >
          <Plus size={14} />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => { vibrate(); onClose(); }}
          className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-2 ml-1 flex-shrink-0"
          title="Close Panel"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {sessions.map((s, i) => (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{ display: s.id === activeId ? "block" : "none" }}
          >
            <TerminalPane
              bus={bus}
              connected={connected}
              sessionId={s.id}
              isVisible={s.id === activeId}
              isFocused={s.id === activeId}
              showFocusBorder={false}
              bgIndex={i}
            />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="h-full flex items-center justify-center text-text-muted text-sm">
            Creating terminal session...
          </div>
        )}
      </div>
    </div>
  );
}
