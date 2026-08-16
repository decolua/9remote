"use client";

import { Folder, Monitor } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { shortenHomePath } from "../lib/workspaceGrouping";

// Shown in the panes area before any terminal exists: the two things a fresh session
// can actually do. Stacks on mobile.
export default function TerminalEmptyState({ onAddWorkspace, onOpenRemote, recent = [], homeDir, onOpenRecent }) {
  const { t } = useI18n();

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-5 p-6 overflow-y-auto modal-scrollable">
      <h2 className="text-sm text-text-muted">{t("workspaces.emptyTitle")}</h2>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-lg">
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
        <div className="flex items-center gap-2 flex-wrap justify-center max-w-lg">
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
