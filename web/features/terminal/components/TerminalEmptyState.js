"use client";

import { Folder, Monitor } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { shortenHomePath } from "../lib/workspaceGrouping";
import { SHORTCUTS, SESSION_INDEX_SHORTCUT, shortcutLabel } from "../constants/shortcuts";

// Hero-side shortcut hints: the two that matter before any terminal exists, plus the
// pointer to the full sheet.
const HINT_IDS = ["newTerminal", "palette", "help"];

// Shown in the panes area before any terminal exists. Desktop mirrors the login shell —
// hero on the left, actions on the right; mobile stacks to just the actions.
export default function TerminalEmptyState({ onAddWorkspace, onOpenRemote, recent = [], homeDir, onOpenRecent }) {
  const { t } = useI18n();
  const hints = HINT_IDS
    .map((id) => SHORTCUTS.find((s) => s.id === id))
    .filter(Boolean);

  return (
    <div className="h-full w-full grid lg:grid-cols-2 overflow-y-auto modal-scrollable">
      {/* HERO — desktop only, mirrors the login page */}
      <section className="hidden lg:flex flex-col justify-center px-10 xl:px-16 py-12 relative overflow-hidden">
        <div className="login-hero-glow" aria-hidden />
        <div className="relative z-10 max-w-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-2/60 border border-border-subtle font-mono text-[11px] text-text-muted mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse-glow" />
            {t("login.termConnected")}
          </div>
          <h1 className="text-4xl xl:text-5xl font-extrabold tracking-tight leading-[1.02] mb-4 text-text">
            {t("login.heroLine1")}<br />
            <span className="login-hero-grad">{t("login.heroLine3")}</span>
          </h1>
          <p className="text-text-muted text-sm leading-relaxed max-w-sm mb-8">
            {t("login.tagline")}
          </p>

          <div className="rounded-xl border border-border-subtle bg-surface-2/50 overflow-hidden max-w-sm">
            <div className="px-3.5 py-2 border-b border-border-subtle font-mono text-[10px] text-text-subtle">
              {t("shortcuts.title")}
            </div>
            <ul className="p-2">
              {hints.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-4 px-2 py-1.5">
                  <span className="text-xs text-text-muted min-w-0 truncate">{t(`shortcuts.${entry.id}`)}</span>
                  <kbd className="font-mono text-[11px] text-text-subtle px-1.5 py-0.5 bg-surface-3/60 rounded-[4px] whitespace-nowrap flex-shrink-0">
                    {shortcutLabel(entry)}
                  </kbd>
                </li>
              ))}
              <li className="flex items-center justify-between gap-4 px-2 py-1.5">
                <span className="text-xs text-text-muted min-w-0 truncate">{t("shortcuts.sessionIndex")}</span>
                <kbd className="font-mono text-[11px] text-text-subtle px-1.5 py-0.5 bg-surface-3/60 rounded-[4px] whitespace-nowrap flex-shrink-0">
                  {shortcutLabel(SESSION_INDEX_SHORTCUT)}
                </kbd>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ACTIONS */}
      <section className="flex flex-col items-center justify-center gap-5 p-6 sm:p-10 lg:border-l lg:border-border-subtle lg:bg-surface-1/60 relative">
        <div className="login-mobile-glow lg:hidden" aria-hidden />
        <div className="relative z-10 w-full max-w-sm flex flex-col items-center gap-5">
          <h2 className="text-sm text-text-muted">{t("workspaces.emptyTitle")}</h2>

          <div className="flex flex-col sm:flex-row lg:flex-col gap-3 w-full">
            <Card
              icon={<Folder size={26} className="text-orange-500/80" />}
              title={t("workspaces.cardWorkspaceTitle")}
              desc={t("workspaces.cardWorkspaceDesc")}
              action={t("workspaces.selectFolder")}
              onClick={onAddWorkspace}
            />
            <Card
              icon={<Monitor size={26} className="text-brand-500/80" />}
              title={t("workspaces.cardRemoteTitle")}
              desc={t("workspaces.cardRemoteDesc")}
              action={t("menu.remoteDesktop")}
              onClick={onOpenRemote}
            />
          </div>

          {!!recent.length && (
            <div className="flex items-center gap-2 flex-wrap justify-center">
              <span className="text-[11px] text-text-subtle">{t("workspaces.recentFolders")}</span>
              {recent.slice(0, 4).map((w) => (
                <button
                  key={w.path}
                  onClick={() => { vibrate(); onOpenRecent?.(w.path); }}
                  className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text bg-surface-2/60 hover:bg-surface-2 rounded-[3px] transition-colors max-w-[180px] truncate"
                  title={w.path}
                >
                  {shortenHomePath(w.path, homeDir)}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Card({ icon, title, desc, action, onClick }) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      disabled={!onClick}
      className="group flex-1 flex flex-col items-center gap-2 p-6 bg-surface hover:bg-surface-2 border border-border-subtle hover:border-brand-500/40 rounded-brand-lg transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-elev active:scale-[0.99] active:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
    >
      <span className="transition-transform duration-200 group-hover:scale-110">{icon}</span>
      <span className="text-sm font-semibold text-text">{title}</span>
      <span className="text-xs text-text-muted text-center leading-snug">{desc}</span>
      <span className="mt-1 px-3 py-1 text-xs font-medium text-brand-500 bg-brand-500/10 group-hover:bg-brand-500/20 rounded-[3px] transition-colors">{action}</span>
    </button>
  );
}
