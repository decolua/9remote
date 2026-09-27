"use client";

import { useState } from "react";
import { Mic, X, ExternalLink } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import { useVoiceLang } from "@/shared/hooks/useVoiceInput";
import { useVoiceStore } from "@/shared/stores/voiceStore";
import { VOICE_ENDPOINT_DEFAULT, VOICE_PRESETS, VOICE_FREE_STT_ENABLED, chat, recordClip, resolveVoiceCfg, sttErrText, transcribeBlob } from "@/shared/lib/voiceStt";

const FIELD_CLS = "w-full px-2.5 py-1.5 rounded bg-bg border border-border-subtle text-xs font-mono text-text placeholder-text-muted focus:outline-none focus:border-brand-500";
const BTN_CLS = "px-3 py-1.5 rounded-brand text-xs font-medium transition-colors";
const CHIP_CLS = "px-2.5 py-1 rounded-brand text-[11px] border transition-colors";
const CHIP_ON = "border-brand-500 bg-brand-500/10 text-brand-400 dark:border-white/30 dark:bg-white/10 dark:text-white";
const CHIP_OFF = "border-border-subtle bg-surface-2/30 text-text-muted hover:text-text hover:bg-surface-2";

// One flat engine row — Free (AI, no key) first when enabled, then Browser, then keyed providers.
const ENGINES = [
  ...(VOICE_FREE_STT_ENABLED ? [{ id: "opencode", mode: "ai", label: "Free" }] : []),
  { id: "browser", mode: "browser", label: "Browser" },
  { id: "gemini", mode: "ai", label: VOICE_PRESETS.gemini.label },
  { id: "openrouter", mode: "ai", label: VOICE_PRESETS.openrouter.label },
  { id: "custom", mode: "ai", label: VOICE_PRESETS.custom.label },
];

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${CHIP_CLS} ${active ? CHIP_ON : CHIP_OFF}`}
    >
      {children}
    </button>
  );
}

function Status({ state }) {
  if (!state) return null;
  const cls = state.busy ? "text-text-muted animate-pulse" : state.ok ? "text-green-500" : "text-red-400";
  return <p className={`text-[11px] leading-relaxed break-words ${cls}`}>{state.msg}</p>;
}

// Config modal: the engine, provider and keys are one flat form. Selecting a
// preset fills endpoint+model, only keys are typed.
function VoiceConfigModal({ onClose }) {
  const store = useVoiceStore();
  const { mode, setMode, preset, setPreset, setField } = store;
  const { locale } = useI18n();
  const [voiceLang, setVoiceLang] = useVoiceLang(locale);
  const [langOpen, setLangOpen] = useState(false);
  const [keyState, setKeyState] = useState(null);
  const [voiceState, setVoiceState] = useState(null);
  const busy = keyState?.busy || voiceState?.busy;
  const currentLang = SUPPORTED_LOCALES.find((l) => l.code === voiceLang);

  const hasKey = preset === "opencode" && VOICE_FREE_STT_ENABLED
    ? true // free tier — no key, the agent holds the client fingerprint
    : preset === "gemini"
    ? store.geminiKeys.some((k) => k.trim())
    : preset === "openrouter" ? !!store.openrouterKey.trim() : !!store.customKey.trim();
  // Presets prefill the model; an empty override falls back to the preset default.
  const effModel = preset === "custom"
    ? store.customModel
    : (store[`${preset}Model`] || "").trim() || VOICE_PRESETS[preset].model;

  const testKey = async () => {
    vibrate();
    if (preset === "opencode" && VOICE_FREE_STT_ENABLED) { setKeyState({ ok: true, msg: "No key needed — use Test voice" }); return; }
    setKeyState({ busy: true, msg: "Testing…" });
    try {
      const cfg = resolveVoiceCfg(useVoiceStore.getState());
      await chat(cfg, { model: cfg.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
      setKeyState({ ok: true, msg: "Key & model OK" });
    } catch (err) { setKeyState({ ok: false, msg: sttErrText(err) }); }
  };

  const testVoice = async () => {
    vibrate();
    if (!hasKey) { setVoiceState({ ok: false, msg: "Enter an API key first" }); return; }
    setVoiceState({ busy: true, msg: "Recording…" });
    try {
      const text = await transcribeBlob(useVoiceStore.getState(), await recordClip(), voiceLang);
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
        <div className="flex-1 overflow-y-auto modal-scrollable px-5 pb-5 flex flex-col gap-3 min-h-[320px]">
      {/* Dictation language — applies to both engines */}
      <button
        type="button"
        onClick={() => { vibrate(); setLangOpen(true); }}
        className="w-full px-3 py-2 rounded-brand bg-surface-2/50 text-left flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors"
      >
        <span className="flex-1 min-w-0 truncate">Language</span>
        {voiceLang === "auto" && (
          <span className="text-xs text-text-muted">Auto</span>
        )}
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
        {ENGINES.map((e) => (
          <Chip
            key={e.id}
            active={mode === e.mode && (e.mode === "browser" || preset === e.id)}
            onClick={() => {
              vibrate();
              if (e.mode === "browser") setMode("browser");
              else { setMode("ai"); setPreset(e.id); }
            }}
          >
            {e.label}
          </Chip>
        ))}
      </div>

      {mode === "browser" ? (
        <p className="text-xs leading-relaxed text-text-muted">
          Uses the browser&apos;s built-in speech recognition (Chrome, Safari, Edge). Not available in Firefox.
        </p>
      ) : (
        <>
          <p className={`text-[11px] leading-relaxed ${hasKey ? "text-text-muted" : "text-amber-500"}`}>
            {preset === "custom"
              ? "Any OpenAI-compatible /chat/completions endpoint"
              : `${VOICE_PRESETS[preset].note}`}
            {!hasKey && " · No key yet"}
          </p>

          {preset !== "custom" && (
            <div>
              <div className="text-xs font-semibold text-text mb-1">Model</div>
              <input
                type="text"
                value={store[`${preset}Model`] || ""}
                onChange={(e) => setField(`${preset}Model`, e.target.value)}
                placeholder={effModel}
                className={FIELD_CLS}
                autoComplete="off"
              />
            </div>
          )}

          {preset === "gemini" && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-text">API keys</span>
                <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[11px] text-brand-500 hover:text-brand-400 hover:underline transition-colors">
                  AI Studio <ExternalLink size={10} />
                </a>
              </div>
              <div className="flex flex-col gap-1.5">
                {store.geminiKeys.map((k, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      type="password"
                      value={k}
                      onChange={(e) => {
                        const next = [...store.geminiKeys];
                        next[i] = e.target.value;
                        setField("geminiKeys", next);
                      }}
                      placeholder={`Key ${i + 1}`}
                      className={FIELD_CLS}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setField("geminiKeys", store.geminiKeys.filter((_, j) => j !== i))}
                      aria-label={`Remove key ${i + 1}`}
                      className="shrink-0 p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setField("geminiKeys", [...store.geminiKeys, ""])}
                  className="self-start text-[11px] text-brand-500 hover:text-brand-400 transition-colors"
                >
                  + Add key
                </button>
              </div>
            </div>
          )}
          {preset === "openrouter" && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-text">API key</span>
                <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[11px] text-brand-500 hover:text-brand-400 hover:underline transition-colors">
                  OpenRouter <ExternalLink size={10} />
                </a>
              </div>
              <input
                type="password"
                value={store.openrouterKey}
                onChange={(e) => setField("openrouterKey", e.target.value)}
                placeholder="sk-or-…"
                className={FIELD_CLS}
                autoComplete="off"
              />
            </div>
          )}
          {preset === "custom" && (
            <>
              <div>
                <div className="text-xs font-semibold text-text mb-1">Endpoint</div>
                <input type="text" value={store.customEndpoint} onChange={(e) => setField("customEndpoint", e.target.value)} placeholder={VOICE_ENDPOINT_DEFAULT} className={FIELD_CLS} autoComplete="off" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text mb-1">Model</div>
                <input type="text" value={store.customModel} onChange={(e) => setField("customModel", e.target.value)} placeholder="e.g. google/gemini-2.5-flash" className={FIELD_CLS} autoComplete="off" />
              </div>
              <div>
                <div className="text-xs font-semibold text-text mb-1">API key</div>
                <input type="password" value={store.customKey} onChange={(e) => setField("customKey", e.target.value)} placeholder="sk-…" className={FIELD_CLS} autoComplete="off" />
              </div>
            </>
          )}

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
      {/* Language picker stacks above this modal */}
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
  const preset = useVoiceStore((s) => s.preset);
  const setEnabled = useVoiceStore((s) => s.setEnabled);
  const [open, setOpen] = useState(false);
  const engine = mode === "ai" ? (VOICE_PRESETS[preset]?.label || "AI") : "Browser";

  const handleOpen = () => {
    vibrate();
    setOpen(true);
  };

  const rowCls = dense
    ? "w-full py-1 text-sm text-text flex items-center gap-2.5 cursor-pointer select-none"
    : "w-full px-3 py-2 rounded-brand flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 cursor-pointer select-none transition-colors";

  return (
    <>
      <div className={rowCls} onClick={handleOpen}>
        <Mic size={16} className={`${dense ? "text-text" : "text-brand-500 dark:text-white"} flex-shrink-0`} />
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="truncate">Voice input</span>
          <span className="text-xs text-text-muted truncate">{engine}</span>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleOpen(); }}
          title="Voice configuration"
          aria-label="Voice configuration"
          className="shrink-0 px-2 h-7 flex items-center justify-center rounded-brand border border-border-subtle/60 hover:border-border hover:bg-surface-3/50 text-text-muted hover:text-text text-xs transition-colors"
        >
          Config
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); vibrate(); setEnabled(!enabled); }}
          aria-label="Toggle voice input"
          className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors border border-transparent ${enabled ? "bg-brand-500 dark:bg-white" : "bg-surface-2 dark:border-white/15"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-4 dark:bg-dark-800" : "translate-x-0.5 dark:bg-white/50"}`} />
        </button>
      </div>
      {open && <VoiceConfigModal onClose={() => setOpen(false)} />}
    </>
  );
}
