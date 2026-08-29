"use client";

import { useState, useEffect } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import SitesList from "@/features/terminal/components/SitesList";
import {
  Folder, Monitor, Smartphone, Plus, Settings, Globe, Pencil, Trash2, ChevronRight, Zap, ArrowRight
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { shortenHomePath } from "@/features/terminal/lib/workspaceGrouping";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";
import SessionCard from "./SessionCard";

const UNGROUPED_KEY = "ungrouped";

// Mobile-only: on desktop the sidebar already lists workspaces and terminals with more
// operations, so this screen would only be a larger, weaker copy of it.
export default function SessionList({
  sessions, cwdBySession = {}, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenMobile,
  tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected,
  onStopCodespace, isActive = true, busRef, subscribeToPush, unsubscribeFromPush,
  onResumeAgentSession = null,
  notifications = {}, sessionStatus = {}, clearNotification, agentVersion,
  updateAvailable = null, canSelfUpdate = false, onUpdate, onRestart, carrier = "ws",
  workspaces = [], onRenameWorkspace, onDeleteWorkspace, onAddWorkspace,
  fileBus, homeDir, recentWorkspaces = [], shells = []
}) {
  const { t } = useI18n();
  // Actions only — same reason as TerminalHeader: this writes context/callbacks.
  const openMenu = useSlideMenuStore((s) => s.open);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);

  const [sheet, setSheet] = useState(null);                 // { target } — a long-pressed terminal
  const [renaming, setRenaming] = useState(null);           // { kind, id, value }
  const [confirm, setConfirm] = useState(null);             // { kind, id, name }
  const [terminalModal, setTerminalModal] = useState(null); // { workspaceId }
  const [sitesOpen, setSitesOpen] = useState(false);

  // Mod+Alt+T opens the new-terminal modal on the ungrouped workspace
  // (browser reserves bare Mod+T)
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setTerminalModal({ workspaceId: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: false,
      theme: "default",
      busRef,
      // Remote and Sites sit in this screen's own header, and Files needs a workspace
      // that has not been picked yet — all three would be duplicates or dead entries.
      hideActions: ["remote", "files", "sites", "terminalSettings"],
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      notifications,
      clearNotification,
      agentVersion,
      carrier
    });
    setCallbacks({
      onRemote: null,
      onFiles: null,
      onSites: null,
      onSelectSite: null,
      onRefreshSites: null,
      onCodespace: null,
      onLogout,
      onThemeChange: null,
      onStopCodespace,
      onUpdate,
      onRestart
    });
  }, [
    isActive, connected, onOpenRemote, codespaceInfo, onLogout, onStopCodespace, onUpdate,
    onRestart, setContext, setCallbacks, busRef, connectionMode, subscribeToPush,
    unsubscribeFromPush, agentVersion, carrier, tunnelUrl, apiKey, notifications,
    clearNotification
  ]);

  const sections = [
    ...workspaces.map((w) => ({ key: w.id, id: w.id, name: w.name, path: w.path || null })),
    { key: UNGROUPED_KEY, id: null, name: t("workspaces.ungrouped"), path: null, isUnassigned: true }
  ];
  const sessionsIn = (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === workspaceId);
  // A history row naming a terminal that still exists focuses it instead of resuming a
  // second copy of the same conversation.
  const liveSessionIds = new Set(sessions.map((s) => s.id));

  const submitRename = () => {
    const value = renaming?.value?.trim();
    if (value) {
      if (renaming.kind === "session") onRename?.(renaming.id, value);
      else onRenameWorkspace?.(renaming.id, value);
    }
    setRenaming(null);
  };

  const confirmDelete = () => {
    if (confirm?.kind === "session") onDelete?.(confirm.id);
    else onDeleteWorkspace?.(confirm.id);
    setConfirm(null);
  };

  const showBanner = connected && (
    isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) ||
    isWebOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) ||
    updateAvailable
  );

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Translucent bar like the old design; safe-area padding for notched phones, where
          env() is 0 everywhere else. */}
      <header
        className={`relative z-10 bg-surface/80 backdrop-blur-md px-4 py-3 ${PANEL_HEADER_H_CLASS} flex items-center justify-between gap-2 flex-shrink-0 border-b border-border-subtle`}
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-1.5 bg-brand-500/10 rounded-brand flex-shrink-0">
            <Zap className="text-brand-500 w-5 h-5" />
          </div>
          <h1 className="text-text text-lg font-semibold truncate">{t("sessions.headerTitle")}</h1>
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
            title={connected ? t("sessions.connected") : t("sessions.disconnected")}
          />
          {!connected && codespaceDisconnected && (
            <span className="text-red-400 text-xs truncate">{t("sessions.codespaceStopped")}</span>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {onOpenRemote && (
            <HeaderButton icon={Monitor} label={t("menu.remoteDesktop")} onClick={onOpenRemote} disabled={!connected} />
          )}
          {onOpenMobile && (
            <HeaderButton icon={Smartphone} label={t("mobile.androidDevice")} onClick={onOpenMobile} disabled={!connected} />
          )}
          <HeaderButton icon={Globe} label={t("menu.sites")} onClick={() => setSitesOpen(true)} disabled={!connected} />
          <HeaderButton icon={Settings} label={t("menu.title")} onClick={openMenu} />
        </div>
      </header>

      <div
        className="relative z-10 flex-1 overflow-auto modal-scrollable px-4 pt-4 pb-6"
        style={{ overflowAnchor: "none" }}
      >
        {showBanner && (
          <AgentOutdatedBanner
            agentVersion={agentVersion}
            webVersion={process.env.NEXT_PUBLIC_SERVER_VERSION}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
            onUpdate={onUpdate}
            className="mb-4"
          />
        )}

        {!sessions.length && !workspaces.length ? (
          <WelcomeCards
            onAddWorkspace={onAddWorkspace}
            onOpenRemote={onOpenRemote}
            recent={recentWorkspaces}
            homeDir={homeDir}
            connected={connected}
          />
        ) : (
          <div className="space-y-5">
            {sections.map((section) => {
              const items = sessionsIn(section.id);
              if (section.isUnassigned && !items.length) return null;
              return (
                <WorkspaceSection
                  key={section.key}
                  section={section}
                  items={items}
                  connected={connected}
                  shellCount={shells.length}
                  busRef={busRef}
                  cwdBySession={cwdBySession}
                  fileBus={fileBus}
                  homeDir={homeDir}
                  sessionStatus={sessionStatus}
                  notifications={notifications}
                  onSelect={onSelect}
                  onNewTerminal={() => setTerminalModal({ workspaceId: section.id })}
                  onSessionMenu={(session) => setSheet({ target: session })}
                  onRenameSession={(s) => setRenaming({ kind: "session", id: s.id, value: s.name })}
                  onDeleteSession={(s) => setConfirm({ kind: "session", id: s.id, name: s.name })}
                  onWorkspaceMenu={section.isUnassigned ? null : (action) => {
                    if (action === "rename") setRenaming({ kind: "workspace", id: section.id, value: section.name });
                    else setConfirm({ kind: "workspace", id: section.id, name: section.name });
                  }}
                />
              );
            })}

            <ActionRow
              icon={<Plus size={16} />}
              label={t("workspaces.newWorkspace")}
              onClick={onAddWorkspace}
              disabled={!connected}
            />
          </div>
        )}
      </div>

      {/* Terminal actions: quick rename/delete buttons on each card, long press for the
          full sheet. Workspaces carry their buttons in the header instead. */}
      {sheet && (
        <ActionSheet
          title={sheet.target.name}
          onClose={() => setSheet(null)}
          actions={[
            {
              icon: Pencil,
              label: t("sessions.editName"),
              onClick: () => setRenaming({ kind: "session", id: sheet.target.id, value: sheet.target.name })
            },
            {
              icon: Trash2,
              danger: true,
              label: t("sessions.deleteTitle"),
              onClick: () => setConfirm({ kind: "session", id: sheet.target.id, name: sheet.target.name })
            }
          ]}
        />
      )}

      {renaming && (
        <PromptDialog
          title={renaming.kind === "session" ? t("sessions.editName") : t("workspaces.rename")}
          value={renaming.value}
          onChange={(value) => setRenaming({ ...renaming, value })}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={confirmDelete}
        title={confirm?.kind === "session" ? t("sessions.deleteTitle") : t("workspaces.deleteTitle")}
        message={confirm?.kind === "session"
          ? t("sessions.deleteMessage", { name: confirm?.name || "" })
          : t("workspaces.deleteMessage", { name: confirm?.name || "" })}
      />

      {terminalModal && (
        <NewTerminalModal
          onClose={() => setTerminalModal(null)}
          onCreate={(name, shellId, agent, yolo, cwd, nameIsAuto) => {
            onCreate?.(name, terminalModal.workspaceId, shellId, cwd || null, agent, yolo, nameIsAuto);
            setTerminalModal(null);
          }}
          shells={shells}
          busRef={busRef}
          onResumeAgentSession={onResumeAgentSession}
          onSelectSession={onSelect}
          liveSessionIds={liveSessionIds}
          connected={connected}
          workspacePath={workspaces.find((w) => w.id === terminalModal.workspaceId)?.path || null}
          workspaceName={workspaces.find((w) => w.id === terminalModal.workspaceId)?.name || ""}
          fileBus={fileBus}
          homeDir={homeDir}
          suggestName={`${t("terminal.defaultName")} ${sessionsIn(terminalModal.workspaceId).length + 1}`}
        />
      )}

      <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} busRef={busRef} isOpen={sitesOpen} onClose={() => setSitesOpen(false)} />
    </div>
  );
}

// One workspace: a header naming the folder and where it is, then its terminals.
function WorkspaceSection({
  section, items, connected, cwdBySession = {}, fileBus, homeDir, sessionStatus, notifications, shellCount = 1, busRef,
  onSelect, onNewTerminal, onSessionMenu, onWorkspaceMenu, onRenameSession, onDeleteSession
}) {
  const { t } = useI18n();
  const gitPath = section.path || items.find((s) => s.workspacePath)?.workspacePath;
  // Read only to tell a terminal's own branch apart from the workspace's — the header
  // does not show it, since every card below already carries one.
  const { branch } = useWorkspaceGit(gitPath, fileBus);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section>
      {/* The whole header row toggles: a chevron alone is a small target on a phone, and
          the name beside it is not doing anything else. */}
      <div className="flex items-center gap-1 pb-2">
        <button
          onClick={() => { vibrate(); setCollapsed((v) => !v); }}
          className="flex-1 min-w-0 flex items-center gap-2 py-1 text-left"
        >
          <ChevronRight
            size={14}
            className={`flex-shrink-0 text-text-subtle transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
          />
          <Folder size={17} className="text-text flex-shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-medium text-text truncate" title={section.name}>{section.name}</span>
            {gitPath && (
              <span className="block text-[11px] text-text-subtle truncate" title={gitPath}>
                {shortenHomePath(gitPath, homeDir)}
              </span>
            )}
          </span>
          {collapsed && items.length > 0 && (
            <span className="flex-shrink-0 text-[11px] text-text-subtle">{items.length}</span>
          )}
        </button>

        <IconAction icon={Plus} label={t("terminal.newTerminal")} onClick={onNewTerminal} disabled={!connected} />
        {onWorkspaceMenu && (
          <>
            <IconAction icon={Pencil} label={t("workspaces.rename")} onClick={() => onWorkspaceMenu("rename")} />
            <IconAction icon={Trash2} label={t("workspaces.delete")} danger onClick={() => onWorkspaceMenu("delete")} />
          </>
        )}
      </div>

      {!collapsed && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
          {items.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              status={sessionStatus[session.id]}
              hasNotification={!!notifications[session.id]}
              connected={connected}
              cwd={cwdBySession[session.id] || null}
              fileBus={fileBus}
              homeDir={homeDir}
              shellCount={shellCount}
              onSelect={onSelect}
              onLongPress={onSessionMenu}
              onRename={onRenameSession}
              onDelete={onDeleteSession}
              onResume={busRef ? (session) => busRef.current?.emit("session-resume", { sessionId: session.id }) : null}
            />
          ))}
          {/* Inline dashed card to add a terminal — desktop only; hidden on mobile when the
              workspace has terminals (the header Plus covers it there). */}
          <button
            onClick={() => { vibrate(); onNewTerminal(); }}
            disabled={!connected}
            className={`min-h-[164px] rounded-xl p-3 items-center justify-center gap-1.5 text-sm border border-dashed border-brand-500/40 bg-brand-500/5 text-text-muted transition-all duration-150 ${items.length ? "hidden sm:flex" : "flex"} ${connected ? "hover:border-brand-500 hover:text-brand-500 hover:bg-brand-500/10 hover:-translate-y-1" : "opacity-50 cursor-not-allowed"}`}
            title={t("workspaces.addTerminal")}
          >
            <Plus className="text-brand-500" size={16} /> <span className="text-brand-500">{t("terminal.newTerminal")}</span>
          </button>
        </div>
      )}
    </section>
  );
}

function IconAction({ icon: Icon, label, onClick, danger, disabled }) {
  return (
    <button
      onClick={() => { vibrate(); onClick(); }}
      disabled={disabled}
      title={label}
      className={`p-2 flex-shrink-0 transition-colors disabled:opacity-30 ${
        danger ? "text-text-subtle active:text-red-500" : "text-text-subtle active:text-text"
      }`}
    >
      <Icon size={17} />
    </button>
  );
}

function HeaderButton({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      onClick={() => { vibrate(); onClick(); }}
      disabled={disabled}
      title={label}
      className={`p-2 rounded-brand transition-colors active:scale-[0.96] ${
        disabled ? "text-text-subtle cursor-not-allowed" : "text-text-muted hover:text-text hover:bg-surface-2"
      }`}
    >
      <Icon className="w-5 h-5" />
    </button>
  );
}

// First run: the two things this app can do as naked poster halves on a cinematic
// stage (same white light as login), split by a hairline + brand dot.
function WelcomeCards({ onAddWorkspace, onOpenRemote, recent, homeDir, connected }) {
  const { t } = useI18n();
  const remoteReady = connected && !!onOpenRemote;
  return (
    // Bleed past the scroll container's px-4 pt-4 pb-6 so the backdrop reaches the edges
    <div className="empty-stage w-[calc(100%_+_2rem)] h-[calc(100%_+_2.5rem)] -mx-4 -mt-4 -mb-6">
      <div className="empty-grid" />

      <button
        onClick={() => { vibrate(); onAddWorkspace?.(); }}
        disabled={!connected}
        className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
      >
        <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagWorkspace")}</span>
        <span className="empty-word login-hero-grad">{t("workspaces.emptyWordTerminal")}</span>
        <span
          className="empty-meta"
          dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaWorkspace") }}
        />
        <span className="empty-go">
          {t("workspaces.selectFolder")}
          <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
        </span>
        {!!recent.length && (
          <span className="flex flex-wrap gap-1.5 mt-4 max-w-full">
            {recent.slice(0, 3).map((w) => (
              <span
                key={w.path}
                role="button"
                title={w.path}
                onClick={(e) => { e.stopPropagation(); vibrate(); onAddWorkspace?.(w.path); }}
                className="welcome-chip path-tail px-2 py-1 text-[11px] font-mono text-text-muted rounded-full truncate max-w-[46%]"
              >
                {shortenHomePath(w.path, homeDir)}
              </span>
            ))}
          </span>
        )}
      </button>

      <div className="empty-hairline" aria-hidden />

      <button
        onClick={() => { vibrate(); onOpenRemote?.(); }}
        disabled={!remoteReady}
        className="empty-half text-left active:opacity-80 enabled:active:scale-[0.99] transition-all duration-150 disabled:opacity-40 disabled:saturate-50"
      >
        <span className="empty-idx"><b>02</b> / {t("workspaces.emptyTagRemote")}</span>
        <span className="empty-word login-hero-grad">{t("workspaces.emptyWordRemote")}</span>
        <span
          className="empty-meta"
          dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaRemote") }}
        />
        {remoteReady && (
          <span className="empty-go">
            {t("menu.remoteDesktop")}
            <ArrowRight size={14} className="text-brand-500" strokeWidth={2.2} />
          </span>
        )}
      </button>
    </div>
  );
}

function ActionRow({ icon, label, onClick, disabled }) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      disabled={disabled}
      className="flex items-center gap-1.5 px-1 py-2 text-[13px] font-medium uppercase text-brand-500 active:opacity-60 disabled:opacity-40 transition-opacity"
    >
      {icon}
      {label}
    </button>
  );
}

// Bottom sheet: thumb-reachable, unlike a centred dialog on a tall phone.
function ActionSheet({ title, actions, onClose }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 animate-in fade-in duration-150" />
      <div
        className="relative w-full bg-surface rounded-t-brand-lg pb-[max(0.5rem,env(safe-area-inset-bottom))] animate-in slide-in-from-bottom duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 text-[12px] text-text-muted truncate border-b border-border-subtle">{title}</div>
        {actions.map(({ icon: Icon, label, onClick, danger }) => (
          <button
            key={label}
            onClick={() => { vibrate(); onClose(); onClick(); }}
            className={`w-full flex items-center gap-3 px-4 py-3.5 text-[14px] active:bg-surface-2 ${
              danger ? "text-red-500" : "text-text"
            }`}
          >
            <Icon size={17} /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

