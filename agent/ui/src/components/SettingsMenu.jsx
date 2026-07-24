import { useState, useEffect, useRef } from "preact/hooks";
import { useI18n } from "../i18n";
import { SUPPORTED_LOCALES } from "../i18n/config";
import { TERMINAL_THEME_OPTIONS } from "../lib/terminal";

const HELP_URL = "https://docs.9remote.cc/";

// Settings dropdown — language + terminal settings + docs/reset/shutdown.
// Used in PageHeader (glass-btn) and TerminalView header (compact trigger).
export default function SettingsMenu({ isStopped, onStop, onShutdown, theme, terminalFont, setTerminalFont, terminalThemeKey, setTerminalTheme, webglEnabled, setWebglEnabled, showFolderButton, setShowFolderButton, showGitButton, setShowGitButton, showNoteButton, setShowNoteButton, variant = "glass" }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
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
          <TerminalSettingsRow
            open={termOpen}
            onToggle={() => setTermOpen((v) => !v)}
            theme={theme}
            terminalFont={terminalFont}
            setTerminalFont={setTerminalFont}
            terminalThemeKey={terminalThemeKey}
            setTerminalTheme={setTerminalTheme}
            webglEnabled={webglEnabled}
            setWebglEnabled={setWebglEnabled}
            showFolderButton={showFolderButton}
            setShowFolderButton={setShowFolderButton}
            showGitButton={showGitButton}
            setShowGitButton={setShowGitButton}
            showNoteButton={showNoteButton}
            setShowNoteButton={setShowNoteButton}
          />
          <MenuAction icon="menu_book" label={t("header.documentation")} onClick={() => run(() => window.open(HELP_URL, "_blank"))} />
          {!isStopped && <MenuAction icon="restart_alt" label={t("header.resetShort")} onClick={() => run(onStop)} />}
          <MenuAction icon="power_settings_new" label={t("header.shutdownShort")} danger onClick={() => run(onShutdown)} />
        </div>
      )}
      {langOpen && <LanguageModal onClose={() => setLangOpen(false)} />}
    </div>
  );
}

// Collapsible Terminal Settings — font size + theme palette + toggles (mirrors web MenuItems).
function TerminalSettingsRow({ open, onToggle, theme, terminalFont, setTerminalFont, terminalThemeKey, setTerminalTheme, webglEnabled, setWebglEnabled, showFolderButton, setShowFolderButton, showGitButton, setShowGitButton, showNoteButton, setShowNoteButton }) {
  const { t } = useI18n();
  const Toggle = ({ icon, label, value, onChange, hint }) => (
    <div className="flex items-center gap-2 py-0.5">
      <span className="material-symbols-outlined text-base" style={{ color: "var(--brand-500)" }}>{icon}</span>
      <div className="flex flex-col flex-1">
        <span className="text-sm">{t(label)}</span>
        {hint && <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t(hint)}</span>}
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-brand-500" : "bg-surface-2"}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
  return (
    <div className="px-1">
      <button onClick={onToggle} className="w-full text-left px-2 py-1.5 text-sm flex items-center gap-2 card-act rounded-lg" style={{ color: "var(--text-main)" }}>
        <span className="material-symbols-outlined text-base">terminal</span>
        <span className="flex-1">{t("menu.terminalSettings")}</span>
        <span className="material-symbols-outlined text-base transition-transform" style={{ transform: open ? "rotate(180deg)" : "none", color: "var(--text-muted)" }}>expand_more</span>
      </button>
      {open && (
        <div className="pl-7 pr-2 pb-1.5 space-y-1.5">
          <Toggle icon="memory" label="menu.webgl" hint="menu.webglHint" value={webglEnabled} onChange={setWebglEnabled} />
          <div className="flex items-center gap-2 pt-1.5">
            <span className="material-symbols-outlined text-base" style={{ color: "var(--brand-500)" }}>text_fields</span>
            <span className="text-sm flex-1">{t("menu.fontSize")}</span>
            <select
              value={terminalFont ?? 14}
              onChange={(e) => setTerminalFont(Number(e.target.value))}
              className="text-sm rounded-lg px-2 py-1 focus:outline-none"
              style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
            >
              {Array.from({ length: 9 }, (_, i) => i + 10).map((n) => (
                <option key={n} value={n}>{n}px</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-base" style={{ color: "var(--brand-500)" }}>palette</span>
            <span className="text-sm flex-1">{t("menu.terminalTheme")}</span>
            <select
              value={terminalThemeKey}
              onChange={(e) => setTerminalTheme(e.target.value)}
              className="text-xs rounded-lg px-2 py-1 max-w-[55%] focus:outline-none"
              style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)" }}
            >
              <option value="default">Vesper (Default)</option>
              {TERMINAL_THEME_OPTIONS
                .filter((opt) => opt.mode === theme)
                .map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
            </select>
          </div>
          <div className="my-0.5" style={{ borderTop: "1px solid var(--border)" }} />
          <Toggle icon="folder_open" label="menu.showFolder" value={showFolderButton} onChange={setShowFolderButton} />
          <Toggle icon="merge" label="menu.showGit" value={showGitButton} onChange={setShowGitButton} />
          <Toggle icon="edit_note" label="menu.showNote" value={showNoteButton} onChange={setShowNoteButton} />
        </div>
      )}
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
