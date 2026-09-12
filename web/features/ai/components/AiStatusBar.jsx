"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Zap, Package, Trash2, Shield, Sparkles, ChevronUp, Check } from "@/shared/components/ui/Icon";
import { getEngineConfig } from "../registry";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";

export const AiStatusBar = memo(function AiStatusBar({
  sessionId = "",
  sessionName = "",
  engine = "claude",
  isTurnRunning: propTurnRunning = false,
  onModeChange,
  onOpenSkills,
  onOpenMcp,
  onClear
}) {
  const storeTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata);
  const permissionMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode || "default");

  const isTurnRunning = storeTurnRunning !== undefined ? storeTurnRunning : propTurnRunning;
  const skillsCount = metadata?.skills?.length || 0;
  const mcpCount = metadata?.mcpServers?.length || 0;

  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target)) setModeMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const modes = getEngineConfig(engine).permissionModes || [];
  const activeMode = modes.find((m) => m.id === permissionMode) || modes[0];

  return (
    <div className="relative h-6 px-3 bg-surface/50 border-t border-border-subtle/50 flex items-center justify-end text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20 gap-3">
      {/* Left: Live State indicator only */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isTurnRunning && (
          <div className="flex items-center gap-1 text-brand-500 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            <span className="hidden sm:inline">Active</span>
          </div>
        )}
      </div>

      {/* Right: Permission mode, Skills, MCP, Clear & Cost */}
      <div className="flex items-center gap-2.5 shrink-0">
        {activeMode && modes.length > 0 && (
          <div ref={modeMenuRef} className="relative">
            <button
              type="button"
              onClick={() => { vibrate(); setModeMenuOpen((v) => !v); }}
              className="hover:text-text flex items-center gap-1 transition-colors"
              title="Change permission mode (Shift+Tab)"
            >
              {permissionMode === "bypassPermissions" || permissionMode === "auto" ? (
                <Sparkles size={11} className="text-warning shrink-0" />
              ) : permissionMode === "plan" ? (
                <Zap size={11} className="text-accent shrink-0" />
              ) : (
                <Shield size={11} className="text-text-muted shrink-0" />
              )}
              <span>{activeMode.label}</span>
              <ChevronUp size={11} className={`text-text-muted transition-transform ${modeMenuOpen ? "" : "rotate-180"}`} />
            </button>
            {modeMenuOpen && (
              <div className="absolute right-0 bottom-[calc(100%+6px)] min-w-[220px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
                <div className="px-2 py-0.5 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-border-subtle mb-1">
                  Permission Mode
                </div>
                {modes.map((cm) => (
                  <button
                    key={cm.id}
                    type="button"
                    onClick={() => {
                      vibrate();
                      onModeChange?.(cm.id);
                      setModeMenuOpen(false);
                    }}
                    className={`w-full px-2 py-1.5 rounded text-left text-xs flex flex-col gap-0.5 transition-colors cursor-pointer ${
                      permissionMode === cm.id
                        ? "bg-brand-500/15 text-brand-400 font-semibold"
                        : "text-text-muted hover:text-text hover:bg-surface-2"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span>{cm.label}</span>
                      {permissionMode === cm.id && <Check size={12} className="text-brand-400 shrink-0" />}
                    </div>
                    <span className="text-[10px] text-text-muted/70 font-normal font-sans leading-tight">
                      {cm.desc}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => { vibrate(); onOpenSkills?.(); }}
          className="hover:text-text flex items-center gap-1 transition-colors"
          title="Browse agent skills"
        >
          <Zap size={11} className="text-accent shrink-0" />
          <span>Skills ({skillsCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onOpenMcp?.(); }}
          className="hover:text-text flex items-center gap-1 transition-colors"
          title="Browse MCP servers"
        >
          <Package size={11} className="text-accent shrink-0" />
          <span>MCP ({mcpCount})</span>
        </button>

        <button
          type="button"
          onClick={() => { vibrate(); onClear?.(); }}
          className="hover:text-danger flex items-center transition-colors p-0.5 rounded hover:bg-surface-2"
          title="Clear chat history"
        >
          <Trash2 size={12} />
        </button>

        {/* Cost readout hidden on request — stats still tracked in the store, re-enable
            by rendering `useAiStore((s) => s.bySession[sessionId]?.stats)?.totalCost`. */}
        {/* {stats.totalCost > 0 && (
          <>
            <span className="text-border-subtle">|</span>
            <span className="text-text font-semibold">${stats.totalCost.toFixed(3)}</span>
          </>
        )} */}
      </div>
    </div>
  );
});
