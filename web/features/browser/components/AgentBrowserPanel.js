"use client";

// Jev agent panel for the host browser engine. Goal in, timeline out: each step
// streams from the host as it happens (browserUse:step). Config mirrors the
// voice-input pattern — per-device store that pushes to the host's KV.
import { useEffect, useRef, useState } from "react";
import { Bot, Image, Loader2, Play, Settings, Square, X } from "@/shared/components/ui/Icon";
import { useBrowserUseStore } from "@/shared/stores/browserUseStore";
import BrowserUseConfigForm, { useBrowserUseInvoke } from "@/shared/components/ui/BrowserUseSettings";

const RESULT_STYLES = {
  ok: "text-emerald-500",
  stale: "text-amber-500",
  low_confidence: "text-amber-500",
  error: "text-red-500",
  rejected: "text-red-500"
};
const outcomeStyle = (outcome) =>
  outcome === "needs_verification" ? "text-emerald-500"
    : outcome === "done" ? "text-emerald-500"
      : "text-amber-500";

export default function AgentBrowserPanel({ busRef, onClose }) {
  const store = useBrowserUseStore();
  const [goal, setGoal] = useState("");
  const [url, setUrl] = useState("");
  const [steps, setSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [shot, setShot] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profiles, setProfiles] = useState([{ name: "default" }]);
  const [stuckTable, setStuckTable] = useState(null);
  const [newProfile, setNewProfile] = useState("");
  const timelineRef = useRef(null);

  const invoke = useBrowserUseInvoke(busRef);

  useEffect(() => {
    const b = busRef?.current;
    const onStep = (step) => setSteps((prev) => [...prev, step]);
    b?.on?.("browserUse:step", onStep);
    return () => b?.off?.("browserUse:step", onStep);
  }, [busRef]);

  useEffect(() => { invoke("profiles.list").then((r) => r.ok && setProfiles(r.profiles)); }, [invoke]);
  useEffect(() => { timelineRef.current?.scrollTo?.({ top: 1e9 }); }, [steps]);

  const start = async () => {
    if (!goal.trim() || running) return;
    setSteps([]); setResult(null); setShot(null); setStuckTable(null); setRunning(true);
    const res = await invoke("run", { goal: goal.trim(), url: url.trim() || undefined, profile: store.profile });
    setRunning(false);
    setResult(res);
    // A dead end is only readable against the world the agent saw — pull the table.
    if (res.ok && ["blocked", "no_progress", "decision_error", "low_confidence"].includes(res.outcome)) {
      const state = await invoke("state", { profile: store.profile });
      if (state.ok) setStuckTable(state.actions || []);
    }
  };
  const addProfile = async () => {
    const name = newProfile.trim();
    if (!name) return;
    const res = await invoke("profiles.create", { name });
    if (res.ok) { setProfiles((prev) => [...prev, { name }]); store.setProfile(name); setNewProfile(""); }
  };
  const removeProfile = async () => {
    if (store.profile === "default") return;
    if (!window.confirm(`Delete profile "${store.profile}" and its saved logins?`)) return;
    const res = await invoke("profiles.delete", { name: store.profile });
    if (res.ok) { setProfiles((prev) => prev.filter((p) => p.name !== store.profile)); store.setProfile("default"); }
  };
  // Real cancel: the engine loop stops at the next decision boundary; the UI
  // stays "running" until the run actually returns (never lies about stopping).
  const stop = () => invoke("run.cancel", { profile: store.profile });

  const takeShot = async () => {
    const res = await invoke("shot", { profile: store.profile });
    if (res.ok) setShot(`data:image/jpeg;base64,${res.image}`);
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg-secondary">
      <div className="h-11 flex items-center gap-2 px-3 border-b border-border-subtle shrink-0">
        <Bot size={15} className="text-brand-500" />
        <span className="text-sm font-medium text-text">Jev browser agent</span>
        <span className={`text-xs ${running ? "text-brand-500" : result ? outcomeStyle(result.outcome) : "text-text-muted"}`}>
          {running ? "running…" : result ? result.outcome : "idle"}
        </span>
        <div className="flex-1" />
        <select
          value={store.profile}
          onChange={(e) => store.setProfile(e.target.value)}
          className="px-2 py-1 bg-surface-2 rounded-brand text-xs text-text"
        >
          {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <input
          type="text" value={newProfile} onChange={(e) => setNewProfile(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addProfile()}
          placeholder="new profile" spellCheck={false}
          className="w-24 px-2 py-1 bg-surface-2 rounded-brand text-xs text-text placeholder-text-muted"
        />
        {store.profile !== "default" && (
          <button onClick={removeProfile} className="px-2 py-1 text-xs text-text-muted hover:text-red-500" title="delete profile">
            <X size={13} />
          </button>
        )}
        <button onClick={() => setSettingsOpen(true)} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand" title="settings">
          <Settings size={15} />
        </button>
        <button onClick={onClose} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand" title="close">
          <X size={16} />
        </button>
      </div>

      <div className="p-3 border-b border-border-subtle shrink-0 flex flex-col gap-2">
        <input
          type="text" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="start url (optional)"
          spellCheck={false} autoCapitalize="off"
          className="px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none"
        />
        <div className="flex gap-2">
          <input
            type="text" value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            placeholder="goal — e.g. open the third article in Tâm sự"
            className="flex-1 px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none"
          />
          {running
            ? <button onClick={stop} className="px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-amber-500 flex items-center gap-1"><Square size={13} />stop</button>
            : <button onClick={start} disabled={!goal.trim()} className="px-3 py-1.5 bg-brand-500 text-white rounded-brand text-sm flex items-center gap-1 disabled:opacity-40">
              <Play size={13} />run
            </button>}
          <button onClick={takeShot} className="px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text-muted" title="screenshot"><Image size={14} /></button>
        </div>
      </div>

      <div ref={timelineRef} className="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-xs space-y-1">
        {steps.length === 0 && <p className="text-text-muted">steps appear here as the agent works</p>}
        {steps.map((s) => (
          <div key={`${s.seq}-${s.ts}`} className="flex items-start gap-2">
            <span className="text-text-muted shrink-0 w-6 text-right">#{s.seq}</span>
            <span className="text-brand-500 shrink-0 w-28 truncate">{s.operation}</span>
            <span className="text-text shrink-0">{s.targetIndex ? `[${s.targetIndex}]` : ""}</span>
            <span className="text-text truncate flex-1">{s.label}</span>
            {s.probability !== undefined && <span className="text-text-muted shrink-0">p={Number(s.probability).toFixed(2)}</span>}
            <span className={`shrink-0 ${RESULT_STYLES[s.result] || "text-text-muted"}`}>{s.result}</span>
          </div>
        ))}
        {running && <Loader2 size={13} className="animate-spin text-brand-500" />}
        {result && !result.ok && <p className="text-red-500">{result.error}</p>}
        {result?.ok && (
          <div className="pt-2 border-t border-border-subtle text-text-muted">
            {result.outcome} — {result.reason} · {result.metrics?.steps} steps · {result.metrics?.modelCalls} jev calls
          </div>
        )}
        {stuckTable && (
          <details className="pt-2">
            <summary className="text-text-muted cursor-pointer">elements the agent saw ({stuckTable.length})</summary>
            <div className="pt-1 space-y-0.5">
              {stuckTable.slice(0, 60).map((a) => (
                <div key={a.id} className="text-text-muted">
                  [{a.id}] {a.kind} {String(a.label).slice(0, 70)}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {shot && (
        <div className="p-3 border-t border-border-subtle shrink-0">
          <img src={shot} alt="browser screenshot" className="w-full rounded-brand border border-border-subtle" />
        </div>
      )}

      {settingsOpen && (
        <div className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setSettingsOpen(false)}>
          <div className="w-full max-w-md bg-bg-secondary rounded-brand border border-border-subtle p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-text">Jev settings</span>
              <button onClick={() => setSettingsOpen(false)} className="p-1 text-text-muted hover:text-text"><X size={15} /></button>
            </div>
            <BrowserUseConfigForm busRef={busRef} />
          </div>
        </div>
      )}
    </div>
  );
}

