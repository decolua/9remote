"use client";

// Create-AVD wizard, three steps: device profile → system image → name.
// Mirrors Android Studio's Device Manager flow, scoped to what a remote
// mirror actually needs (no custom hardware editor).

import { useMemo, useState } from "react";
import { X, Smartphone, Check, ChevronRight, Loader2, Search } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

function profileLabel(p) {
  return p.name || p.id;
}

export default function CreateAvdModal({
  isOpen, onClose, profiles, images, installedImages, hostAbi,
  loading, onCreate, onRefreshImages
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [profile, setProfile] = useState(null);
  const [imagePath, setImagePath] = useState(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const close = () => {
    setStep(1); setProfile(null); setImagePath(null); setName(""); setQuery(""); setCreating(false);
    onClose?.();
  };

  // Images the wizard can actually boot on this host: matching ABI first.
  const installable = useMemo(() => {
    // Phone-shaped, matching-ABI images only: the rest cannot boot usefully
    // here. When hostAbi is unknown every ABI is allowed rather than none.
    return images.filter((img) => {
      if (/automotive|wear|tv|ps16k|tablet/i.test(img.path)) return false;
      return !hostAbi || img.path.includes(hostAbi);
    });
  }, [images, hostAbi]);

  const shown = useMemo(() => {
    if (!query) return installable;
    const q = query.toLowerCase();
    return installable.filter((img) => img.path.toLowerCase().includes(q));
  }, [installable, query]);

  const byApi = useMemo(() => {
    const m = new Map();
    for (const img of shown) {
      const api = Number(img.path.split(";")[1]?.replace("android-", "")) || 0;
      if (!m.has(api)) m.set(api, []);
      m.get(api).push(img);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [shown]);

  const installedSet = useMemo(() => new Set(installedImages), [installedImages]);

  if (!isOpen) return null;

  const canNext = step === 1 ? !!profile : step === 2 ? !!imagePath : false;
  const submit = async () => {
    if (creating) return;
    setCreating(true);
    const ok = await onCreate?.({ name: name.trim(), imagePath, deviceId: profile.id });
    setCreating(false);
    if (ok) close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 fade-in" onClick={close}>
      <div
        className="bg-bg border border-border rounded-brand-xl w-full max-w-md max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <Smartphone size={15} className="text-brand-500 flex-shrink-0" />
          <span className="text-sm text-text flex-1">{t("mobile.avdCreateTitle")}</span>
          <button onClick={() => { vibrate(); close(); }} className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand">
            <X size={15} />
          </button>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border flex-shrink-0">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-1 flex-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-brand ${step === s ? "bg-brand-500/15 text-brand-500" : step > s ? "text-green-500" : "text-text-muted"}`}>
                {step > s ? <Check size={10} /> : s}
                {step === s && <span className="ml-1">{t(`mobile.avdStep${s}`)}</span>}
              </span>
              {s < 3 && <div className={`flex-1 h-px ${step > s ? "bg-green-500/50" : "bg-border"}`} />}
            </div>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable p-3 space-y-1.5">
          {step === 1 && (
            <>
              {profiles.length === 0 && (
                <p className="text-text-muted text-xs text-center py-4">{t("mobile.avdNoProfiles")}</p>
              )}
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { vibrate(); setProfile(p); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-brand-lg border text-left transition-colors ${
                    profile?.id === p.id ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface hover:bg-surface-2"
                  }`}
                >
                  <Smartphone size={14} className="text-text-muted flex-shrink-0" />
                  <span className="text-xs text-text flex-1 truncate">{profileLabel(p)}</span>
                  {profile?.id === p.id && <Check size={13} className="text-brand-500" />}
                </button>
              ))}
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex items-center gap-1.5 bg-surface-2 rounded-brand px-2 py-1 mb-2">
                <Search size={13} className="text-text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("mobile.imagesSearch")}
                  className="bg-transparent text-xs text-text placeholder-text-muted outline-none w-full"
                />
              </div>
              {installedSet.size > 0 && (
                <p className="text-[10px] text-text-muted px-1 pb-1">{t("mobile.avdInstalledBelow")}</p>
              )}
              {byApi.map(([api, imgs]) => (
                <div key={api} className="space-y-1">
                  <p className="text-[10px] text-text-muted px-1 pt-1">Android {api}</p>
                  {/* Installed first within the group: picking one of those
                      starts the AVD now instead of downloading gigabytes. */}
                  {[...imgs].sort((a, b) => Number(installedSet.has(b.path)) - Number(installedSet.has(a.path))).map((img) => {
                    const installed = installedSet.has(img.path);
                    return (
                    <button
                      key={img.path}
                      onClick={() => { vibrate(); setImagePath(img.path); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-brand-lg border text-left transition-colors ${
                        imagePath === img.path ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface hover:bg-surface-2"
                      }`}
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs text-text truncate">
                          {img.path.split(";")[2]?.replace(/_/g, " ") || img.path}
                        </span>
                      </div>
                      {installed && <Check size={12} className="text-green-500 flex-shrink-0" />}
                      {imagePath === img.path && <Check size={13} className="text-brand-500" />}
                    </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}

          {step === 3 && (
            <div className="space-y-2 p-1">
              <p className="text-xs text-text-muted">
                {profileLabel(profile || {})} · Android {imagePath ? imagePath.split(";")[1]?.replace("android-", "") : "?"} · {imagePath?.split(";")[2]?.replace(/_/g, " ")}
              </p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("mobile.avdNamePlaceholder")}
                autoFocus
                className="w-full bg-surface border border-border rounded-brand px-3 py-2 text-sm text-text placeholder-text-muted outline-none focus:border-brand-500"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          {step > 1 && (
            <button onClick={() => { vibrate(); setStep(step - 1); }} className="px-3 py-1.5 text-xs text-text-muted hover:text-text rounded-brand">
              {t("common.back")}
            </button>
          )}
          <div className="flex-1" />
          {step < 3 && (
            <button
              onClick={() => { vibrate(); setStep(step + 1); }}
              disabled={!canNext}
              className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-brand disabled:opacity-40 flex items-center gap-1"
            >
              {t("common.next") || "Next"} <ChevronRight size={12} />
            </button>
          )}
          {step === 3 && (
            <button
              onClick={submit}
              disabled={!name.trim() || !imagePath || creating}
              className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-brand disabled:opacity-40 flex items-center gap-1.5"
            >
              {creating && <Loader2 size={12} className="animate-spin" />}
              {t("mobile.avdCreateTitle")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
