"use client";

import { useState, useEffect } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import SitesList from "@/features/terminal/components/SitesList";
import {
  Folder, Monitor, Plus, Settings, Globe, Pencil, Trash2, ChevronRight, Zap
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
  sessions, cwdBySession = {}, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote,
  tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected,
  onStopCodespace, isActive = true, socketRef, subscribeToPush, unsubscribeFromPush,
  notifications = {}, sessionStatus = {}, clearNotification, agentVersion,
  updateAvailable = null, canSelfUpdate = false, onUpdate, onRestart, transport = "ws",
  workspaces = [], onRenameWorkspace, onDeleteWorkspace, onAddWorkspace,
  fileSocket, homeDir, recentWorkspaces = [], shells = []
}) {
  const { t } = useI18n();
  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

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
      socketRef,
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
      transport
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
    onRestart, setContext, setCallbacks, socketRef, connectionMode, subscribeToPush,
    unsubscribeFromPush, agentVersion, transport, tunnelUrl, apiKey, notifications,
    clearNotification
  ]);

  const sections = [
    ...workspaces.map((w) => ({ key: w.id, id: w.id, name: w.name, path: w.path || null })),
    { key: UNGROUPED_KEY, id: null, name: t("workspaces.ungrouped"), path: null, isUnassigned: true }
  ];
  const sessionsIn = (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === workspaceId);

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
                  cwdBySession={cwdBySession}
                  fileSocket={fileSocket}
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
          confirmLabel={t("common.confirm")}
          cancelLabel={t("common.cancel")}
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
          onCreate={(name, shellId, agent, yolo, cwd) => {
            onCreate?.(name, terminalModal.workspaceId, shellId, cwd || null, agent, yolo);
            setTerminalModal(null);
          }}
          shells={shells}
          socketRef={socketRef}
          workspacePath={workspaces.find((w) => w.id === terminalModal.workspaceId)?.path || null}
          workspaceName={workspaces.find((w) => w.id === terminalModal.workspaceId)?.name || ""}
          fileSocket={fileSocket}
          homeDir={homeDir}
          suggestName={`${t("terminal.defaultName")} ${sessionsIn(terminalModal.workspaceId).length + 1}`}
        />
      )}

      <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} socketRef={socketRef} isOpen={sitesOpen} onClose={() => setSitesOpen(false)} />
    </div>
  );
}

// One workspace: a header naming the folder and where it is, then its terminals.
function WorkspaceSection({
  section, items, connected, cwdBySession = {}, fileSocket, homeDir, sessionStatus, notifications, shellCount = 1,
  onSelect, onNewTerminal, onSessionMenu, onWorkspaceMenu, onRenameSession, onDeleteSession
}) {
  const { t } = useI18n();
  const gitPath = section.path || items.find((s) => s.workspacePath)?.workspacePath;
  // Read only to tell a terminal's own branch apart from the workspace's — the header
  // does not show it, since every card below already carries one.
  const { branch } = useWorkspaceGit(gitPath, fileSocket);
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
            <span className="block text-[13px] font-medium text-text truncate">{section.name}</span>
            {gitPath && (
              <span className="block text-[11px] text-text-subtle truncate">
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
              fileSocket={fileSocket}
              homeDir={homeDir}
              shellCount={shellCount}
              onSelect={onSelect}
              onLongPress={onSessionMenu}
              onRename={onRenameSession}
              onDelete={onDeleteSession}
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

// First run: the two things this app can do, each taking half the screen so neither
// reads as the secondary one.
function WelcomeCards({ onAddWorkspace, onOpenRemote, recent, homeDir, connected }) {
  const { t } = useI18n();
  return (
    <div className="h-full flex flex-col gap-3 py-3">
      <BigCard
        icon={<Folder size={40} strokeWidth={1.25} />}
        title={t("workspaces.cardWorkspaceTitle")}
        desc={t("workspaces.cardWorkspaceDesc")}
        action={t("workspaces.selectFolder")}
        onClick={onAddWorkspace}
        disabled={!connected}
      >
        {!!recent.length && (
          <span className="flex flex-wrap gap-1.5 justify-center pt-3 w-full">
            {recent.slice(0, 3).map((w) => (
              <span
                key={w.path}
                role="button"
                onClick={(e) => { e.stopPropagation(); vibrate(); onAddWorkspace?.(w.path); }}
                className="px-2 py-1 text-[11px] text-text-muted bg-surface-2/70 border border-border-subtle rounded-brand truncate max-w-[46%]"
              >
                {shortenHomePath(w.path, homeDir)}
              </span>
            ))}
          </span>
        )}
      </BigCard>

      <BigCard
        icon={<Monitor size={40} strokeWidth={1.25} />}
        title={t("workspaces.cardRemoteTitle")}
        desc={t("workspaces.cardRemoteDesc")}
        action={t("menu.remoteDesktop")}
        onClick={onOpenRemote}
        disabled={!connected || !onOpenRemote}
      />
    </div>
  );
}

function BigCard({ icon, title, desc, action, onClick, disabled, children }) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      disabled={disabled}
      className="flex-1 min-h-0 card-elev border border-border-subtle p-6 flex flex-col items-center justify-center gap-2 text-center transition-transform duration-150 active:scale-[0.985] disabled:opacity-40"
    >
      <span className="text-text">{icon}</span>
      <span className="text-[16px] font-semibold text-text">{title}</span>
      <span className="text-[12px] text-text-muted leading-snug max-w-[36ch]">{desc}</span>
      <span className="mt-1 px-3 py-1.5 text-[12px] font-medium text-text bg-text/10 rounded-brand">
        {action}
      </span>
      {children}
    </button>
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

function PromptDialog({ title, value, onChange, onSubmit, onClose, confirmLabel, cancelLabel }) {
  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative card-elev w-full max-w-xs p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[14px] font-semibold text-text mb-3">{title}</h3>
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onClose(); }}
          className="w-full bg-surface-2 border border-border-subtle rounded-brand px-3 py-2 text-sm text-text outline-none focus:border-brand-500"
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 rounded-brand disabled:opacity-40"
          >
            {confirmLabel}
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-sm text-text-muted bg-surface-2 rounded-brand">
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
