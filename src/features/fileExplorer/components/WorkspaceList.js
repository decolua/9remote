"use client";

import { useState, useEffect } from "react";

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

export default function WorkspaceList({ onSelect, onBrowse, onBack }) {
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    setRecent(getRecentWorkspaces());
  }, []);

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
                  <span className="text-2xl">📁</span>
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
                  <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Browse options */}
        <div>
          <h2 className="text-slate-400 text-sm font-medium mb-3">Browse from</h2>
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
          </div>
        </div>
      </div>
    </div>
  );
}
