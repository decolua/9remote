"use client";

import { memo, useEffect, useRef, useState } from "react";
import Icon, { Zap, Package, Target, Trash2, ChevronUp, Check } from "@/shared/components/ui/Icon";
import { getEngineConfig } from "../registry";
import { useAiStore } from "@/shared/stores/aiStore";
import { vibrate } from "@/shared/utils/vibration";
import TerminalBeam from "@/shared/components/ui/TerminalBeam";

// Colour by the shared mode icon, so a mode reads the same on every engine.
const MODE_ICON_COLOR = {
  Shield: "text-text-muted",
  Pencil: "text-accent",
  Eye: "text-accent",
  Sparkles: "text-warning",
};

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
  const goal = metadata?.goal;
  const modes = getEngineConfig(engine).permissionModes || [];
  // Before the host answers, the engine's own default is the truth — not "default",
  // which is a real mode id on only some engines.
  const storedMode = useAiStore((s) => s.bySession[sessionId]?.permissionMode);
  const permissionMode = storedMode || getEngineConfig(engine).defaultMode;

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

  const activeMode = modes.find((m) => m.id === permissionMode) || modes[0];

  return (
    <div className="relative h-6 px-3 bg-surface/50 border-t border-border-subtle/50 flex items-center text-[11px] font-mono text-text-muted select-none flex-shrink-0 z-20 gap-3">
      {/* Same sweep the terminal pane runs, on the Skills/MCP row */}
      {isTurnRunning && <TerminalBeam className="hidden sm:block" />}

      {/* Left: permission mode leads the row */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {activeMode && modes.length > 0 && (
          <div ref={modeMenuRef} className="relative">
            <button
              type="button"
              onClick={() => { vibrate(); setModeMenuOpen((v) => !v); }}
              className="hover:text-text flex items-center gap-1 transition-colors"
              title="Change permission mode (Shift+Tab)"
            >
              <Icon name={activeMode.icon || "Shield"} size={11} className={`${MODE_ICON_COLOR[activeMode.icon] || "text-text-muted"} shrink-0`} />
              <span>{activeMode.label}</span>
              <ChevronUp size={11} className={`text-text-muted transition-transform ${modeMenuOpen ? "" : "rotate-180"}`} />
            </button>
            {modeMenuOpen && (
              <div className="absolute left-0 bottom-[calc(100%+6px)] min-w-[220px] max-h-56 bg-surface border border-border-subtle rounded-brand shadow-xl overflow-y-auto z-50 p-1 custom-scrollbar">
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
                      <span className="flex items-center gap-1.5">
                        <Icon name={cm.icon || "Shield"} size={12} className={`${MODE_ICON_COLOR[cm.icon] || "text-text-muted"} shrink-0`} />
                        <span>{cm.label}</span>
                      </span>
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

        {/* Codex's persistent goal (`/goal` in the TUI), read from the CLI's own state
            DB. Read-only here: the status dot and the objective are all the pane needs. */}
        {goal?.objective && (
          <div
            className="flex items-center gap-1 min-w-0"
            title={`Goal (${goal.status}): ${goal.objective}`}
          >
            <Target
              size={11}
              className={`shrink-0 ${goal.status === "active" ? "text-danger" : "text-text-muted"}`}
            />
            <span className="truncate max-w-[22ch]">{goal.objective}</span>
          </div>
        )}
      </div>

      {/* Right: Skills, MCP, Clear */}
      <div className="flex items-center gap-2.5 shrink-0">
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
