"use client";

import { memo, useState } from "react";
import { ChevronDown } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useJarvisStore } from "@/shared/stores/jarvisStore";
import { JARVIS_LLM_PROVIDERS, JARVIS_LIVE_VOICES } from "@/shared/lib/jarvisConstants";

const inputCls = "w-full px-3 py-2 rounded-brand bg-surface-2/40 border border-border-subtle text-sm text-text placeholder:text-text-muted/60 outline-none focus:border-brand-500 transition-colors";
const labelCls = "text-[11px] text-text-muted px-1";
const selectCls = "w-full px-3 py-2 rounded-brand bg-surface-2/40 border border-border-subtle text-sm text-text outline-none focus:border-brand-500";

/** A config row that stays one line until opened — the summary IS the status. */
function Section({ title, summary, ok, open, onToggle, children }) {
  return (
    <div className={`rounded-brand border overflow-hidden transition-colors ${open ? "border-brand-500/40" : "border-border-subtle"} bg-surface-2/20`}>
      <button
        type="button"
        onClick={() => { vibrate(); onToggle(); }}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? "bg-emerald-400" : "bg-text-muted/40"}`} />
        <span className="text-sm text-text flex-1 min-w-0 truncate">{title}</span>
        <span className="text-[11px] text-text-muted truncate max-w-[45%]">{summary}</span>
        <ChevronDown size={14} className={`text-text-muted flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-2 border-t border-border-subtle/60 flex flex-col gap-1.5">{children}</div>
      )}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }) {
  return (
    <button
      type="button"
      onClick={() => { vibrate(); onChange(!value); }}
      className="w-full px-3 py-2 rounded-brand text-left flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        <span className="block text-xs text-text-muted truncate">{hint}</span>
      </div>
      <span className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-brand-500" : "bg-surface-2"}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

/**
 * The editable Jarvis configuration — one component, two homes: the settings
 * dialog's Jarvis section and the in-view gear modal. Collapsed by default:
 * three rows whose summary states the whole story (provider · model · key ok).
 * Field order mirrors how a user fills it in: endpoint → key → model → format.
 */
export const JarvisConfigPanel = memo(function JarvisConfigPanel({ busRef }) {
  const settings = useJarvisStore((s) => s.settings);
  const setSettings = useJarvisStore((s) => s.setSettings);
  const [open, setOpen] = useState("");
  const provider = JARVIS_LLM_PROVIDERS.find((p) => p.id === settings.llmProvider) || JARVIS_LLM_PROVIDERS[0];

  // Every change both persists locally and reaches the host immediately — the
  // panel also lives in the settings dialog, where the Jarvis view may be closed.
  const update = (patch) => {
    setSettings(patch);
    const next = { ...settings, ...patch };
    busRef?.current?.emit?.("jarvis:agentConfig", {
      provider: next.llmProvider,
      baseUrl: next.llmBaseUrl,
      apiKey: next.llmKey,
      model: next.agentModel,
      wake: next.wakeOnDone
    });
  };

  // Format is metadata about the endpoint, chosen last — never wipe what the
  // user already typed when they correct it.
  const pickProvider = (id) => {
    if (id !== settings.llmProvider) update({ llmProvider: id });
  };

  return (
    <div className="flex flex-col gap-2">
      <Section
        title="Chat LLM"
        summary={`${provider.label} · ${settings.agentModel || ""}`}
        ok={!!settings.llmKey}
        open={open === "llm"}
        onToggle={() => setOpen(open === "llm" ? "" : "llm")}
      >
        <span className={labelCls}>Endpoint</span>
        <input
          type="text"
          value={settings.llmBaseUrl || ""}
          onChange={(e) => update({ llmBaseUrl: e.target.value })}
          placeholder={provider.baseUrlHint}
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <span className={labelCls}>API key</span>
        <input
          type="password"
          value={settings.llmKey || ""}
          onChange={(e) => update({ llmKey: e.target.value })}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <span className={labelCls}>Model</span>
        <input
          type="text"
          value={settings.agentModel || ""}
          onChange={(e) => update({ agentModel: e.target.value })}
          placeholder={provider.models[0]}
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <span className={labelCls}>Format — must match the endpoint above</span>
        <select
          value={settings.llmProvider}
          onChange={(e) => { vibrate(); pickProvider(e.target.value); }}
          className={selectCls}
        >
          {JARVIS_LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Section>

      <Section
        title="Live voice"
        summary={settings.liveKey ? `${settings.liveModel || "gemini-3.8-live"} · ${settings.liveVoice || "Puck"}` : "no key"}
        ok={!!settings.liveKey}
        open={open === "live"}
        onToggle={() => setOpen(open === "live" ? "" : "live")}
      >
        <input
          type="password"
          value={settings.liveKey || ""}
          onChange={(e) => setSettings({ liveKey: e.target.value })}
          placeholder="Google AI API key"
          autoComplete="off"
          spellCheck={false}
          className={inputCls}
        />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={settings.liveModel || ""}
            onChange={(e) => setSettings({ liveModel: e.target.value })}
            placeholder="gemini-3.8-live"
            autoComplete="off"
            spellCheck={false}
            className={`${inputCls} flex-1 min-w-0`}
          />
          <select
            value={settings.liveVoice || "Puck"}
            onChange={(e) => setSettings({ liveVoice: e.target.value })}
            className="w-24 shrink-0 px-2 py-2 rounded-brand bg-surface-2/40 border border-border-subtle text-sm text-text outline-none focus:border-brand-500"
          >
            {JARVIS_LIVE_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <p className="text-[11px] leading-relaxed text-text-muted px-1">
          Talk to delegate work — billed per minute of audio.
        </p>
      </Section>

      <Toggle
        label="Wake on worker done"
        hint="Jarvis checks the fleet and updates the board"
        value={settings.wakeOnDone}
        onChange={(v) => update({ wakeOnDone: v })}
      />
    </div>
  );
});
