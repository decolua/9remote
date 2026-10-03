"use client";

import { memo, useEffect, useState } from "react";
import { X, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

const WAVE_BARS = [0.3, 0.6, 0.85, 1.0, 0.75, 0.9, 1.0, 0.65, 0.35];
const SHIMMER_BARS = [0.4, 0.8, 1.0, 0.7, 0.9, 0.5, 0.85, 0.35];
const ERR_DISMISS_MS = 5000;

// Error codes come from useVoiceInput (browser + AI engines) — map to user text.
function errText(code, t) {
  if (["not-allowed", "service-not-allowed", "audio-capture"].includes(code)) return t("voice.denied");
  if (code === "network") return t("voice.network");
  if (code === "mic-timeout") return t("voice.micTimeout");
  return String(code);
}

// Mounts fresh per error (keyed by code in VoicePill) — a 5s self-hide timer is
// all the lifecycle it needs, no reset effect.
function ErrorPill({ code, className = "", t }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHidden(true), ERR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, []);
  if (hidden) return null;
  return (
    <div className={`w-fit mx-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 shadow-md text-xs text-red-400 animate-in fade-in slide-in-from-bottom-1 duration-150 pointer-events-none ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
      {errText(code, t)}
    </div>
  );
}

export const VoicePill = memo(function VoicePill({ voice, onDone, onCancel, className = "" }) {
  const { t } = useI18n();
  const err = !voice?.listening && voice?.error ? voice.error : null;
  if (!voice?.listening) {
    return err ? <ErrorPill key={err} code={err} className={className} t={t} /> : null;
  }

  const handleDone = () => {
    vibrate();
    if (onDone) onDone();
    else voice.stop();
  };

  const handleCancel = () => {
    if (onCancel) onCancel();
    else voice.cancel();
  };

  return (
    <div className={`w-fit mx-auto flex items-center gap-2 px-2.5 py-1 rounded-full bg-surface-2/95 border border-border-subtle shadow-md backdrop-blur-md text-xs animate-in fade-in slide-in-from-bottom-1 duration-150 pointer-events-auto ${className}`}>
      {voice.transcribing ? (
        <div className="flex items-center gap-2 px-1 py-0.5">
          <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping shrink-0" />
          {/* Shimmering animated wave bars */}
          <div className="flex items-center gap-[3px] h-3.5">
            {SHIMMER_BARS.map((val, i) => (
              <span
                key={i}
                className="w-[2.5px] rounded-full bg-brand-500/85 animate-pulse transition-all"
                style={{
                  height: `${Math.round(val * 13)}px`,
                  animationDelay: `${i * 100}ms`,
                  animationDuration: "800ms",
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Cancel button on far left */}
          <button
            type="button"
            onClick={handleCancel}
            className="text-text-muted hover:text-text p-1 rounded-full hover:bg-surface-3 transition-colors cursor-pointer shrink-0"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={12} />
          </button>

          <div className="h-3 w-px bg-border-subtle shrink-0" />

          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>

          {/* Audio wave bars responding to voice volume */}
          <div className="flex items-center gap-[2.5px] h-3.5 shrink-0 px-0.5">
            {WAVE_BARS.map((factor, i) => {
              const h = Math.max(3, Math.round(3 + factor * (voice.volume || 0.1) * 11));
              return (
                <span
                  key={i}
                  className="w-[2px] rounded-full bg-brand-500 transition-all duration-75"
                  style={{ height: `${h}px` }}
                />
              );
            })}
          </div>

          <div className="h-3 w-px bg-border-subtle shrink-0" />

          {/* Done button on far right */}
          <button
            type="button"
            onClick={handleDone}
            className="p-1 rounded-full bg-brand-500 hover:bg-brand-600 text-white transition-colors cursor-pointer shadow-xs flex items-center justify-center shrink-0"
            title="Done"
            aria-label="Done"
          >
            <Check size={11} />
          </button>
        </>
      )}
    </div>
  );
});

export default VoicePill;
