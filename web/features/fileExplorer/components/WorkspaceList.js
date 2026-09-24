"use client";

import { useState, useEffect } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { Folder, Home, HardDrive, Sparkles } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

import { MAX_RECENT_WORKSPACES, toPosixPath } from "../constants/fileExplorer.js";

// Per-host namespace: "" = the main host (legacy key, untouched), "@head" = a
// fleet host — one machine's recents never seed another's picker.
const storageKey = (scope = "") => `recentWorkspaces${scope}`;
const MAX_RECENT = MAX_RECENT_WORKSPACES;

// Normalize path-like fields on a persisted entry (migrates old \\ data + guards writes).
const normEntry = (w) => {
  if (!w) return w;
  const next = { ...w };
  if (typeof next.path === "string") next.path = toPosixPath(next.path);
  if (typeof next.lastPath === "string") next.lastPath = toPosixPath(next.lastPath);
  if (Array.isArray(next.openedFiles)) {
    next.openedFiles = next.openedFiles.map((f) => (f && typeof f === "object"
      ? { ...f, path: toPosixPath(f.path) }
      : f));
  }
  if (typeof next.activeFile === "string") next.activeFile = toPosixPath(next.activeFile);
  return next;
};

export function getRecentWorkspaces(scope = "") {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(storageKey(scope)) || "[]").map(normEntry);
  } catch {
    return [];
  }
}

export function addRecentWorkspace(workspacePath, scope = "") {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const all = getRecentWorkspaces(scope);
  const existing = all.find(w => w.path === norm);
  const rest = all.filter(w => w.path !== norm);
  // Preserve lastPath/name/pinned when re-adding existing workspace
  rest.unshift({
    path: norm,
    lastOpened: Date.now(),
    lastPath: existing?.lastPath,
    name: existing?.name,
    pinned: existing?.pinned || false,
    openedFiles: existing?.openedFiles || []
  });
  // Pinned items always kept at top
  const pinned = rest.filter(w => w.pinned);
  const unpinned = rest.filter(w => !w.pinned).slice(0, MAX_RECENT);
  localStorage.setItem(storageKey(scope), JSON.stringify([...pinned, ...unpinned]));
}

export function renameRecentWorkspace(workspacePath, name) {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const recent = getRecentWorkspaces();
  const idx = recent.findIndex(w => w.path === norm);
  if (idx === -1) return;
  recent[idx] = { ...recent[idx], name: name?.trim() || undefined };
  localStorage.setItem(storageKey(), JSON.stringify(recent));
}

export function togglePinWorkspace(workspacePath) {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const recent = getRecentWorkspaces();
  const idx = recent.findIndex(w => w.path === norm);
  if (idx === -1) return;
  recent[idx] = { ...recent[idx], pinned: !recent[idx].pinned };
  // Re-sort: pinned first
  const pinned = recent.filter(w => w.pinned);
  const unpinned = recent.filter(w => !w.pinned);
  localStorage.setItem(storageKey(), JSON.stringify([...pinned, ...unpinned]));
}

export function updateOpenedFiles(workspacePath, openedFiles, activeFile, scope = "") {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const recent = getRecentWorkspaces(scope);
  const idx = recent.findIndex(w => w.path === norm);
  // Normalize stored paths so tabs round-trip cleanly on Windows.
  const files = Array.isArray(openedFiles)
    ? openedFiles.map((f) => (f && typeof f === "object" ? { ...f, path: toPosixPath(f.path) } : f))
    : openedFiles;
  const active = typeof activeFile === "string" ? toPosixPath(activeFile) : activeFile;
  // Auto-create entry so tabs persist even if workspace not yet in recent list
  if (idx === -1) {
    recent.unshift({ path: norm, lastOpened: Date.now(), openedFiles: files, activeFile: active });
    localStorage.setItem(storageKey(scope), JSON.stringify(recent));
    return;
  }
  recent[idx] = { ...recent[idx], openedFiles: files, activeFile: active ?? null };
  localStorage.setItem(storageKey(scope), JSON.stringify(recent));
}

export function updateRecentWorkspacePath(workspacePath, lastPath, scope = "") {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const recent = getRecentWorkspaces(scope);
  const idx = recent.findIndex(w => w.path === norm);
  if (idx === -1) return;
  recent[idx] = { ...recent[idx], lastPath: toPosixPath(lastPath) };
  localStorage.setItem(storageKey(scope), JSON.stringify(recent));
}

export function removeRecentWorkspace(workspacePath, scope = "") {
  if (typeof window === "undefined") return;
  const norm = toPosixPath(workspacePath);
  const recent = getRecentWorkspaces(scope).filter(w => w.path !== norm);
  localStorage.setItem(storageKey(scope), JSON.stringify(recent));
}

export default function WorkspaceList({ onSelect, onBrowse, onBack, isCodespaces, systemInfo }) {
  const { t } = useI18n();
  const [recent, setRecent] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, path: null, name: "" });

  useEffect(() => {
    setRecent(getRecentWorkspaces());
  }, []);

  const handleRemoveClick = (e, workspace) => {
    e.stopPropagation();
    setConfirmDialog({
      isOpen: true,
      path: workspace.path,
      name: workspace.path.split("/").pop() || workspace.path
    });
  };

  const handleConfirmRemove = () => {
    if (confirmDialog.path) {
      removeRecentWorkspace(confirmDialog.path);
      setRecent(getRecentWorkspaces());
    }
    setConfirmDialog({ isOpen: false, path: null, name: "" });
  };

  const formatTime = (timestamp) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return t("common.minutesAgo", { n: minutes });
    if (hours < 24) return t("common.hoursAgo", { n: hours });
    return t("common.daysAgo", { n: days });
  };

  const getWorkspaceName = (fullPath) => {
    return fullPath.split("/").pop() || fullPath;
  };

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-text text-lg font-semibold">{t("files.selectWorkspace")}</h1>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto modal-scrollable">
        {/* Recent Workspaces */}
        {recent.length > 0 && (
          <div className="mb-6">
            <h2 className="text-text-muted text-sm font-medium mb-3">{t("files.recentWorkspaces")}</h2>
            <div className="space-y-2">
              {recent.map((workspace) => (
                <button
                  key={workspace.path}
                  onClick={() => { vibrate(); onSelect(workspace.path); }}
                  className="w-full bg-surface hover:bg-surface-2 rounded-brand-lg p-4 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
                >
                  <Folder size={24} className="text-orange-500/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-text font-medium truncate">
                      {getWorkspaceName(workspace.path)}
                    </div>
                    <div className="text-text-muted text-sm truncate" title={workspace.path}>
                      {workspace.path.replace(/^\/Users\/[^/]+/, "~")}
                    </div>
                    <div className="text-text-muted text-xs mt-1">
                      {formatTime(workspace.lastOpened)}
                    </div>
                  </div>
                  <div
                    onClick={(e) => { vibrate(); handleRemoveClick(e, workspace); }}
                    className="p-2 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-all duration-200 flex-shrink-0"
                    title={t("files.removeRecent")}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <svg className="w-5 h-5 text-text-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Browse options */}
        <div>
          <h2 className="text-text-muted text-sm font-medium mb-3">{t("files.selectWorkspace")}</h2>
          <div className="space-y-2">
            {/* Windows: Show drives */}
            {systemInfo?.isWindows ? (
              <>
                {systemInfo.drives?.map((drive) => (
                  <button
                    key={drive.letter}
                    onClick={() => { vibrate(); onBrowse(drive.path); }}
                    className="w-full bg-surface hover:bg-surface-2 rounded-brand-lg p-4 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
                  >
                    <HardDrive size={24} className="text-blue-500/70" />
                    <div className="flex-1">
                      <div className="text-text font-medium">{t("files.drive", { letter: drive.letter })}</div>
                      <div className="text-text-muted text-sm">{drive.path}</div>
                    </div>
                    <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </>
            ) : (
              <>
                {/* macOS/Linux: Show Home and Root */}
                <button
                  onClick={() => { vibrate(); onBrowse("~"); }}
                  className="w-full bg-surface hover:bg-surface-2 rounded-brand-lg p-4 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
                >
                  <Home size={24} className="text-blue-500/70" />
                  <div className="flex-1">
                    <div className="text-text font-medium">{t("files.home")}</div>
                    <div className="text-text-muted text-sm">~/</div>
                  </div>
                  <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                <button
                  onClick={() => { vibrate(); onBrowse("/"); }}
                  className="w-full bg-surface hover:bg-surface-2 rounded-brand-lg p-4 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
                >
                  <HardDrive size={24} className="text-text-subtle" />
                  <div className="flex-1">
                    <div className="text-text font-medium">{t("files.root")}</div>
                    <div className="text-text-muted text-sm">/</div>
                  </div>
                  <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </>
            )}

            {/* Codespaces workspaces folder */}
            {isCodespaces && (
              <button
                onClick={() => { vibrate(); onBrowse("/workspaces"); }}
                className="w-full bg-purple-500/15 hover:bg-purple-500/25 rounded-brand-lg p-4 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
              >
                <Sparkles size={24} className="text-purple-400" />
                <div className="flex-1">
                  <div className="text-text font-medium">{t("files.codespaces")}</div>
                  <div className="text-purple-400 text-sm">/workspaces</div>
                </div>
                <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ isOpen: false, path: null, name: "" })}
        onConfirm={handleConfirmRemove}
        title={t("files.removeTitle")}
        message={t("files.removeMessage", { name: confirmDialog.name })}
      />
    </div>
  );
}
