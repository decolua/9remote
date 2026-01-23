"use client";

import { useState, useEffect } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

const STORAGE_KEY = "recentWorkspaces";
const MAX_RECENT = 5;

export function getRecentWorkspaces() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecentWorkspace(workspacePath) {
  if (typeof window === "undefined") return;
  const recent = getRecentWorkspaces().filter(w => w.path !== workspacePath);
  recent.unshift({ path: workspacePath, lastOpened: Date.now() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

export function removeRecentWorkspace(workspacePath) {
  if (typeof window === "undefined") return;
  const recent = getRecentWorkspaces().filter(w => w.path !== workspacePath);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
}

export default function WorkspaceList({ onSelect, onBrowse, onBack, isCodespaces }) {
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

    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 24) return `${hours} hours ago`;
    return `${days} days ago`;
  };

  const getWorkspaceName = (fullPath) => {
    return fullPath.split("/").pop() || fullPath;
  };

  return (
    <div className="h-full bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-white text-lg font-semibold">Select Workspace</h1>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto">
        {/* Recent Workspaces */}
        {recent.length > 0 && (
          <div className="mb-6">
            <h2 className="text-slate-400 text-sm font-medium mb-3">Recent Workspaces</h2>
            <div className="space-y-2">
              {recent.map((workspace) => (
                <button
                  key={workspace.path}
                  onClick={() => onSelect(workspace.path)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center gap-3 hover:border-slate-600 transition text-left"
                >
                  <span className="text-2xl flex-shrink-0">📁</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-medium truncate">
                      {getWorkspaceName(workspace.path)}
                    </div>
                    <div className="text-slate-400 text-sm truncate">
                      {workspace.path.replace(/^\/Users\/[^/]+/, "~")}
                    </div>
                    <div className="text-slate-500 text-xs mt-1">
                      {formatTime(workspace.lastOpened)}
                    </div>
                  </div>
                  <div
                    onClick={(e) => handleRemoveClick(e, workspace)}
                    className="p-2 text-slate-500 hover:text-red-400 hover:bg-slate-700 rounded transition flex-shrink-0"
                    title="Remove from recent"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Browse options */}
        <div>
          <h2 className="text-slate-400 text-sm font-medium mb-3">Select Workspace</h2>
          <div className="space-y-2">
            <button
              onClick={() => onBrowse("~")}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center gap-3 hover:border-slate-600 transition text-left"
            >
              <span className="text-2xl">🏠</span>
              <div className="flex-1">
                <div className="text-white font-medium">Home</div>
                <div className="text-slate-400 text-sm">~/</div>
              </div>
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            <button
              onClick={() => onBrowse("/")}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center gap-3 hover:border-slate-600 transition text-left"
            >
              <span className="text-2xl">📂</span>
              <div className="flex-1">
                <div className="text-white font-medium">Root</div>
                <div className="text-slate-400 text-sm">/</div>
              </div>
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* Codespaces workspaces folder */}
            {isCodespaces && (
              <button
                onClick={() => onBrowse("/workspaces")}
                className="w-full bg-purple-900/30 border border-purple-700/50 rounded-lg p-4 flex items-center gap-3 hover:border-purple-600 transition text-left"
              >
                <span className="text-2xl">✨</span>
                <div className="flex-1">
                  <div className="text-white font-medium">Codespaces</div>
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
        title="Remove Workspace"
        message={`Remove "${confirmDialog.name}" from recent workspaces?`}
      />
    </div>
  );
}
