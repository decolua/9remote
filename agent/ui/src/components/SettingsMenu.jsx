import { useState, useEffect, useRef } from "preact/hooks";
import { useI18n } from "../i18n";
import { SUPPORTED_LOCALES } from "../i18n/config";

const HELP_URL = "https://docs.9remote.cc/";

// Settings dropdown — language + docs/reset/shutdown.
export default function SettingsMenu({ isStopped, onStop, onShutdown, variant = "glass" }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const ref = useRef(null);
  const curLocale = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const run = (fn) => { setOpen(false); fn?.(); };

  // Trigger button: glass-btn (header) vs compact term-btn (terminal header)
  const triggerClass = variant === "glass"
    ? "glass-btn w-10 h-10 rounded-xl flex items-center justify-center"
    : "p-1.5 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn";
  const triggerStyle = variant === "glass" ? undefined : { background: "var(--surface-2)", color: "var(--text-main)" };

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen((v) => !v)} title={t("header.settings")} className={triggerClass} style={triggerStyle}>
        <span className="material-symbols-outlined text-xl">settings</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-[80] rounded-lg shadow-lg py-1 min-w-[220px]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <button onClick={() => run(() => setLangOpen(true))} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act" style={{ color: "var(--text-main)" }}>
            <span className="material-symbols-outlined text-base">language</span>
            <span className="flex-1">{curLocale.flag} {curLocale.label}</span>
          </button>
          <div className="my-0.5" style={{ borderTop: "1px solid var(--border)" }} />
          <MenuAction icon="menu_book" label={t("header.documentation")} onClick={() => run(() => window.open(HELP_URL, "_blank"))} />
          {!isStopped && <MenuAction icon="restart_alt" label={t("header.resetShort")} onClick={() => run(onStop)} />}
          <MenuAction icon="power_settings_new" label={t("header.shutdownShort")} danger onClick={() => run(onShutdown)} />
        </div>
      )}
      {langOpen && <LanguageModal onClose={() => setLangOpen(false)} />}
    </div>
  );
}


// Language picker modal — grid of locales (mirrors web)
function LanguageModal({ onClose }) {
  const { t, locale, setLocale } = useI18n();
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="glass-card p-5 flex flex-col gap-4 w-full max-w-lg max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold" style={{ color: "var(--text-main)" }}>{t("header.language")}</h3>
          <button onClick={onClose} className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--text-muted)", cursor: "pointer" }}>close</button>
        </div>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto">
          {SUPPORTED_LOCALES.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl card-act"
              style={{ background: l.code === locale ? "rgba(var(--brand-rgb),0.15)" : "var(--glass-bg)", color: l.code === locale ? "var(--brand-400)" : "var(--text-main)" }}
            >
              <span>{l.flag}</span>
              <span className="flex-1 text-left truncate">{l.label}</span>
              {l.code === locale && <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Single dropdown action row
function MenuAction({ icon, label, danger, onClick }) {
  return (
    <button onClick={onClick} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act" style={{ color: danger ? "var(--danger)" : "var(--text-main)" }}>
      <span className="material-symbols-outlined text-base">{icon}</span> {label}
    </button>
  );
}
