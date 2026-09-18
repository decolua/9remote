"use client";

import { useState } from "react";
import { X, Mic, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import { useVoiceLang } from "@/shared/hooks/useVoiceInput";
import { useVoiceStore } from "@/shared/stores/voiceStore";
import { VOICE_ENDPOINT_DEFAULT, chat, recordClip, transcribeBlob, sttErrText } from "@/shared/lib/voiceStt";

const FIELD_CLS = "w-full px-2.5 py-1.5 rounded bg-bg border border-border-subtle text-xs font-mono text-text placeholder-text-muted focus:outline-none focus:border-brand-500";
const BTN_CLS = "px-3 py-1.5 rounded-brand text-xs font-medium transition-colors";
const MODE_CLS = "px-2.5 py-1 rounded-brand text-[11px] border transition-colors";

const MODES = [
  { value: "browser", label: "Browser" },
  { value: "ai", label: "AI endpoint" },
];

function Status({ state }) {
  if (!state) return null;
  const cls = state.busy ? "text-text-muted animate-pulse" : state.ok ? "text-green-500" : "text-red-400";
  return <p className={`text-[11px] leading-relaxed break-words ${cls}`}>{state.msg}</p>;
}

function VoiceEndpointModal({ onClose }) {
  const { mode, setMode, endpoint, apiKey, model, setField } = useVoiceStore();
  const { locale } = useI18n();
  const [voiceLang, setVoiceLang] = useVoiceLang(locale);
  const [langOpen, setLangOpen] = useState(false);
  const currentLang = SUPPORTED_LOCALES.find((l) => l.code === voiceLang);
  const [keyState, setKeyState] = useState(null);
  const [voiceState, setVoiceState] = useState(null);
  const busy = keyState?.busy || voiceState?.busy;
  const cfg = { endpoint, apiKey, model };

  // No own Escape handler: the host surface (settings dialog / drawer) already
  // closes on Escape and unmounts this modal with it.

  const testKey = async () => {
    vibrate();
    setKeyState({ busy: true, msg: "Testing…" });
    try {
      await chat(cfg, { model: cfg.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
      setKeyState({ ok: true, msg: "Key & model OK" });
    } catch (err) { setKeyState({ ok: false, msg: sttErrText(err) }); }
  };

  const testVoice = async () => {
    vibrate();
    if (!cfg.apiKey || !cfg.model) { setVoiceState({ ok: false, msg: "Enter API key and model first" }); return; }
    setVoiceState({ busy: true, msg: "Recording…" });
    try {
      const text = await transcribeBlob(cfg, await recordClip());
      setVoiceState({ ok: !!text, msg: text || "(empty reply)" });
    } catch (err) { setVoiceState({ ok: false, msg: sttErrText(err) }); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={onClose} />
      <div className="relative card-elev max-w-md w-full max-h-[90dvh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">Voice input</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto modal-scrollable px-5 pb-5 flex flex-col gap-3">
          {/* Dictation language — applies to both engines */}
          <button
            type="button"
            onClick={() => { vibrate(); setLangOpen(true); }}
            className="w-full px-3 py-2 rounded-brand bg-surface-2/50 text-left flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors"
          >
            <span className="flex-1 min-w-0 truncate">Language</span>
            {currentLang && (
              <span className="flex items-center gap-1.5 flex-shrink-0 text-xs text-text-muted">
                <img
                  src={`https://flagcdn.com/w40/${currentLang.country}.png`}
                  alt=""
                  className="w-[17px] h-[12px] object-cover rounded-[2px]"
                  loading="lazy"
                />
                <span>{currentLang.label}</span>
              </span>
            )}
          </button>

          <div className="flex items-center gap-1.5 flex-wrap">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => { vibrate(); setMode(m.value); }}
                className={`${MODE_CLS} ${
                  mode === m.value
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border-subtle bg-surface-2/30 text-text-muted hover:text-text hover:bg-surface-2"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === "browser" ? (
            <p className="text-xs leading-relaxed text-text-muted">
              Uses the browser&apos;s built-in speech recognition (Chrome, Safari, Edge). Not available in Firefox.
            </p>
          ) : (
            <>
              <div>
                <div className="text-xs font-semibold text-text mb-1">Endpoint</div>
                <input type="text" value={endpoint} onChange={(e) => setField("endpoint", e.target.value)} placeholder={VOICE_ENDPOINT_DEFAULT} className={FIELD_CLS} autoComplete="off" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text mb-1">API Key</div>
                <input type="password" value={apiKey} onChange={(e) => setField("apiKey", e.target.value)} placeholder="sk-…" className={FIELD_CLS} autoComplete="off" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text mb-1">Model</div>
                <input type="text" value={model} onChange={(e) => setField("model", e.target.value)} placeholder="e.g. google/gemini-2.5-flash" className={FIELD_CLS} autoComplete="off" />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={testKey} disabled={busy} className={`${BTN_CLS} bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-50`}>Test key</button>
                <button type="button" onClick={testVoice} disabled={busy} className={`${BTN_CLS} bg-surface-2/70 hover:bg-surface-2 text-text disabled:opacity-50`}>Test voice</button>
              </div>
              {keyState && <Status state={keyState} />}
              {voiceState && <Status state={voiceState} />}
            </>
          )}
        </div>
      </div>
      {/* Rendered after the host modal so it stacks above it */}
      {langOpen && (
        <VoiceLangModal
          isOpen={langOpen}
          value={voiceLang}
          onSelect={setVoiceLang}
          onClose={() => setLangOpen(false)}
        />
      )}
    </div>
  );
}

// Row used inside the Plugins section: label + pencil opens the modal, the
// switch shows/hides the mic buttons. `dense` matches the mobile drawer rows.
export default function VoiceEndpointSettings({ dense = false }) {
  const enabled = useVoiceStore((s) => s.enabled);
  const mode = useVoiceStore((s) => s.mode);
  const setEnabled = useVoiceStore((s) => s.setEnabled);
  const [open, setOpen] = useState(false);

  const rowCls = dense
    ? "flex items-center gap-2.5 text-sm text-text"
    : "w-full px-3 py-2 rounded-brand flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors";

  return (
    <>
      <div className={rowCls}>
        <Mic size={16} className="text-brand-500 flex-shrink-0" />
        <button
          type="button"
          onClick={() => { vibrate(); setOpen(true); }}
          className="flex-1 min-w-0 text-left flex flex-col active:scale-[0.99] transition-transform"
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate">Voice input</span>
            <span className="text-xs text-text-muted shrink-0">{mode === "ai" ? "AI" : "Browser"}</span>
            <Pencil size={12} className="text-text-muted shrink-0" />
          </span>
          <span className="text-xs text-text-muted truncate">Speak instead of typing — chat, terminal, remote</span>
        </button>
        <button
          type="button"
          onClick={() => { vibrate(); setEnabled(!enabled); }}
          aria-label="Toggle voice input"
          className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? "bg-brand-500" : "bg-surface-2"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
      {open && <VoiceEndpointModal onClose={() => setOpen(false)} />}
    </>
  );
}
