"use client";

import { useEffect, useState } from "react";
import { Bot, X, Settings, PanelLeft, PanelLeftClose, Mic } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { JarvisChatPanel } from "./JarvisChatPanel";
import { KanbanBoard } from "./KanbanBoard";
import { JarvisSettingsModal } from "./JarvisSettingsModal";
import { useJarvisLiveVoice } from "@/features/jarvis/hooks/useJarvisLiveVoice";
import { useKanbanStore } from "@/shared/stores/kanbanStore";
import { useJarvisStore } from "@/shared/stores/jarvisStore";

// Fleet⇄board re-fold cadence while the overlay is open. Slow on purpose: the
// agent's getState spawns a git probe per cwd, and a busy conductor does not
// need second-by-second cards.
const JARVIS_STATE_POLL_MS = 5000;

/**
 * The coordinator surface: the kanban board the user watches beside the Jarvis
 * chat itself. The chat is the standalone agent (jarvisAgent.js on the host) —
 * no CLI harness, tools applied on every request.
 */
export default function JarvisView({ busRef, fileBus = null, workspacePath = "", onClose }) {
  const settings = useJarvisStore((s) => s.settings);
  const applyBoard = useKanbanStore((s) => s.applyBoard);
  const setSink = useKanbanStore((s) => s.setSink);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // On a phone the split steals half the chat; hiding the board gives the
  // conversation the whole screen. Desktop keeps the split by default.
  const [boardOpen, setBoardOpen] = useState(true);
  // The bus ref settles after mount; the pane needs the instance, not the ref.
  const [bus, setBus] = useState(null);
  useEffect(() => {
    setBus(busRef?.current ?? null);
  }, [busRef]);

  // The parallel live voice conductor — only offered once a key exists.
  const live = useJarvisLiveVoice({ busRef, apiKey: settings.liveKey, voice: settings.liveVoice, model: settings.liveModel });

  // Board wiring: pull the agent's copy, mirror its broadcasts, relay hand moves.
  // The poll re-folds the fleet into the board, so auto cards track their
  // sessions' real state while the overlay is open.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus?.emit || !bus?.on) return;
    // The empty payload is load-bearing: emit(event, cb) hands the server the ack
    // as the FIRST handler arg, so the handler's `cb` stays undefined and the
    // board never arrives. Payload first, ack last — same as every ai: emit.
    const pull = () => bus.emit("jarvis:getState", {}, (res) => {
      if (res?.ok) applyBoard(res.board);
    });
    pull();
    const poll = setInterval(pull, JARVIS_STATE_POLL_MS);
    const onBoard = (board) => applyBoard(board);
    bus.on("jarvis:kanban", onBoard);
    setSink((action) => bus.emit("jarvis:kanban", { action }));
    return () => {
      clearInterval(poll);
      bus.off?.("jarvis:kanban", onBoard);
      setSink(null);
    };
  }, [busRef, applyBoard, setSink]);

  // Any agent setting change reaches the host immediately.
  useEffect(() => {
    bus?.emit?.("jarvis:agentConfig", {
      provider: settings.llmProvider,
      baseUrl: settings.llmBaseUrl,
      apiKey: settings.llmKey,
      model: settings.agentModel,
      wake: settings.wakeOnDone
    });
  }, [bus, settings.llmProvider, settings.llmBaseUrl, settings.llmKey, settings.agentModel, settings.wakeOnDone]);

  // Escape closes the settings modal's owner last, so one key does not peel both.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !settingsOpen) {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, settingsOpen]);

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-150">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border-subtle flex-shrink-0 bg-bg/80 backdrop-blur-sm">
        <Bot size={18} className="text-brand-500 shrink-0" />
        <h2 className="text-sm font-semibold text-text flex-1 min-w-0 truncate">Jarvis Coordinator</h2>
        {settings.liveKey && (
          <button
            type="button"
            onClick={() => {
              vibrate();
              if (live.status === "idle" || live.status === "error") void live.start();
              else live.stop();
            }}
            className={`relative p-1.5 rounded-brand transition-colors ${
              live.status === "live" ? "text-red-500" : "text-text-muted"
            } hover:text-text hover:bg-surface-2`}
            aria-label="Live voice"
            title={live.status === "live" ? "End live voice" : "Live voice — talk to delegate work (Gemini 3.8 Live)"}
          >
            <Mic size={16} />
            {live.status === "live" && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => { vibrate(); setBoardOpen((v) => !v); }}
          className={`p-1.5 rounded-brand transition-colors ${boardOpen ? "text-text" : "text-text-muted"} hover:text-text hover:bg-surface-2`}
          aria-label={boardOpen ? "Hide board" : "Show board"}
          title={boardOpen ? "Hide board" : "Show board"}
        >
          {boardOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>
        <button
          type="button"
          onClick={() => { vibrate(); setSettingsOpen(true); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          aria-label="Jarvis settings"
          title="Jarvis settings"
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          onClick={() => { vibrate(); onClose?.(); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {boardOpen && (
          <div
            className="lg:w-[58%] h-[42%] lg:h-full min-h-0 bg-bg border-b lg:border-b-0 lg:border-r border-border-subtle
              lg:shadow-[6px_0_12px_-6px_rgba(0,0,0,0.15)] lg:relative lg:z-10
              animate-in fade-in slide-in-from-left duration-200"
          >
            <KanbanBoard workspacePath={workspacePath} />
          </div>
        )}
        <div className="flex-1 min-h-0">
          <JarvisChatPanel bus={bus} />
        </div>
      </div>

      {settingsOpen && <JarvisSettingsModal busRef={busRef} onClose={() => setSettingsOpen(false)} />}

      {/* Live voice overlay — transcript + the one control that always ends the call */}
      {live.status !== "idle" && (
        <div className="absolute bottom-3 left-3 right-3 z-20 max-w-md ml-auto pointer-events-none">
          <div className="pointer-events-auto rounded-brand-lg border border-border-subtle bg-surface/95 backdrop-blur-sm shadow-xl p-2.5 max-h-52 flex flex-col">
            <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-border-subtle/60">
              <span className={`w-2 h-2 rounded-full ${live.status === "live" ? "bg-red-500 animate-pulse" : "bg-amber-400 animate-pulse"}`} />
              <span className="text-xs font-medium text-text flex-1">
                Live {live.status === "connecting" ? "— connecting…" : "— listening"}
              </span>
              {live.tokens > 0 && (
                <span className="text-[10px] text-text-muted font-mono" title="Context tokens — the number the bill compounds on">
                  {(live.tokens / 1000).toFixed(1)}k tok
                </span>
              )}
              <button
                type="button"
                onClick={() => { vibrate(); live.stop(); }}
                className="text-xs text-text-muted hover:text-text px-1.5 py-0.5 rounded-brand"
              >
                End
              </button>
            </div>
            {live.error && <p className="text-[11px] text-red-400 px-0.5 pb-1">{live.error}</p>}
            <div className="overflow-y-auto modal-scrollable flex flex-col gap-1 pr-0.5">
              {live.entries.length === 0 && (
                <p className="text-[11px] text-text-muted">Speak to delegate — e.g. “which sessions are free?”</p>
              )}
              {live.entries.map((entry, i) => (
                <p
                  key={i}
                  className={`text-[11px] leading-relaxed ${
                    entry.who === "user" ? "text-text" : entry.who === "jarvis" ? "text-brand-400" : "text-text-muted font-mono"
                  }`}
                >
                  {entry.who === "user" ? "> " : entry.who === "jarvis" ? "Jarvis: " : ""}{entry.text}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
