"use client";

import { useState } from "react";
import { ArrowRight, Folder, GitBranch, Globe, Monitor, Smartphone, Terminal } from "@/shared/components/ui/Icon";

/** Recent chips show the path's TAIL — the project folder is what the eye
 *  hunts for; the head is in the tooltip. */
export function tailOf(path, segments = 2) {
  const parts = String(path).replace(/\/+$/, "").split("/");
  return parts.length <= segments
    ? parts.join("/")
    : `…/${parts.slice(-segments).join("/")}`;
}

/** What "Remote This PC" unlocks — one row per capability the agent actually
 *  serves (terminal, screen, files, git, editor, android mirror, ai, local
 *  sites). Color follows the theme's text tokens (bright on dark). Shared with
 *  the mobile WelcomeCards. */
export function RemoteTargets() {
  const items = [
    { icon: Terminal, label: "Terminal" },
    { icon: Monitor, label: "Screen" },
    { icon: Folder, label: "Files" },
    { icon: GitBranch, label: "Git" },
    { icon: Smartphone, label: "Android" },
    { icon: Globe, label: "Sites" }
  ];
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
      {items.map(({ icon: ItemIcon, label }) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <ItemIcon size={13} className="shrink-0" />
          {label}
        </span>
      ))}
    </span>
  );
}
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import AddHostModal from "@/features/hosts/components/AddHostModal";
import { SHORTCUTS, SESSION_INDEX_SHORTCUT, shortcutLabel } from "../constants/shortcuts";

// The shortcuts that matter before any terminal exists, plus the pointer to the full sheet.
const HINT_IDS = ["newTerminal", "palette", "help"];

// Shown in the panes area before any terminal exists — the same borderless poster stage
// the mobile session list opens on: two naked halves on cinematic white light, split by a
// hairline (vertical on wide screens, horizontal when stacked).
export default function TerminalEmptyState({ onAddWorkspace, onOpenRemote, recent = [], homeDir, onOpenRecent }) {
  const { t } = useI18n();
  const pushView = useTerminalStore((s) => s.pushView);
  // Right half connects ANOTHER machine into the fleet — meaningful everywhere.
  const [addHostOpen, setAddHostOpen] = useState(false);
  const hints = [
    ...HINT_IDS.map((id) => SHORTCUTS.find((s) => s.id === id)).filter(Boolean),
    SESSION_INDEX_SHORTCUT
  ];

  return (
    <div className="h-full w-full empty-stage empty-stage-h">
      <div className="empty-grid" />

      <button
        onClick={() => { vibrate(); onAddWorkspace?.(); }}
        disabled={!onAddWorkspace}
        className="empty-half text-left transition-all duration-150 enabled:hover:opacity-90 enabled:active:scale-[0.99] disabled:opacity-40 disabled:saturate-50"
      >
        <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagVibe")}</span>
        <span className="empty-word login-hero-grad">{t("workspaces.emptyWordVibe")}</span>
        <span className="empty-meta" dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaVibe") }} />
        <span className="empty-go">
          {t("workspaces.emptyGoVibe")}
          <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
        </span>
        {!!recent.length && (
          <span className="flex flex-wrap gap-1.5 mt-4 max-w-full">
            {recent.slice(0, 4).map((w) => (
              <span
                key={w.path}
                role="button"
                title={w.path}
                onClick={(e) => { e.stopPropagation(); vibrate(); onOpenRecent?.(w.path); }}
                className="welcome-chip path-tail px-2 py-1 text-[11px] font-mono text-text-muted rounded-full truncate max-w-[180px]"
              >
                {tailOf(w.path)}
              </span>
            ))}
          </span>
        )}
      </button>

      <>
        <div className="empty-hairline" aria-hidden />

        <button
          onClick={() => { vibrate(); setAddHostOpen(true); }}
            className="empty-half text-left transition-all duration-150 enabled:hover:opacity-90 enabled:active:scale-[0.99] disabled:opacity-40 disabled:saturate-50"
          >
            <span className="empty-idx"><b>02</b> / {t("workspaces.emptyTagPair")}</span>
            <span className="empty-word login-hero-grad">{t("workspaces.emptyWordPair")}</span>
            <span className="empty-meta"><RemoteTargets /></span>
            <span className="empty-go">
              {t("workspaces.emptyGoPair")}
              <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
            </span>
          </button>
      </>

      {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}

      {/* Shortcuts as one mono line along the bottom — a hint, not a second subject, and
          out of the halves so neither is taller than the other. */}
      <div className="hidden lg:flex absolute bottom-0 inset-x-0 z-[2] flex-wrap items-center justify-center gap-x-5 gap-y-1.5 px-8 pb-6 font-mono text-[11px] text-text-subtle">
        {hints.map((entry) => (
          <span key={entry.id} className="flex items-center gap-1.5">
            {t(`shortcuts.${entry.id}`)}
            <kbd className="px-1.5 py-0.5 rounded-[4px] bg-surface-2/60 text-text-muted whitespace-nowrap">
              {shortcutLabel(entry)}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  );
}
