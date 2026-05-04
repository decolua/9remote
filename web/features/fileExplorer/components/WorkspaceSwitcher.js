"use client";

import { useEffect, useState, useMemo } from "react";
import { Folder, FolderOpen, Search, X, Pin, PinOff, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

import {
  getRecentWorkspaces,
  togglePinWorkspace,
  renameRecentWorkspace,
  removeRecentWorkspace
} from "./WorkspaceList.js";

const getBasename = (p) => p?.split("/").filter(Boolean).pop() || p || "";
const shortPath = (p) => p?.replace(/^\/Users\/[^/]+/, "~") || "";

export default function WorkspaceSwitcher({ currentWorkspace, onSelect, onOpenBrowse, onClose, isOpen }) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState([]);
  const [confirmRemove, setConfirmRemove] = useState({ isOpen: false, path: null, name: "" });

  // Reload list when modal opens
  useEffect(() => {
    if (isOpen) {
      setRecent(getRecentWorkspaces());
      setQuery("");
    }
  }, [isOpen]);

  const reload = () => setRecent(getRecentWorkspaces());

  const { pinned, others } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? recent.filter(w => {
          const name = (w.name || getBasename(w.path)).toLowerCase();
          return name.includes(q) || w.path.toLowerCase().includes(q);
        })
      : recent;
    return {
      pinned: filtered.filter(w => w.pinned),
      others: filtered.filter(w => !w.pinned)
    };
  }, [recent, query]);

  const handlePin = (e, path) => {
    e.stopPropagation();
    vibrate();
    togglePinWorkspace(path);
    reload();
  };

  const handleRename = (e, w) => {
    e.stopPropagation();
    vibrate();
    const current = w.name || getBasename(w.path);
    const next = window.prompt("Rename workspace", current);
    if (next !== null) {
      renameRecentWorkspace(w.path, next);
      reload();
    }
  };

  const handleRemoveClick = (e, w) => {
    e.stopPropagation();
    vibrate();
    setConfirmRemove({
      isOpen: true,
      path: w.path,
      name: w.name || getBasename(w.path)
    });
  };

  const confirmRemoveAction = () => {
    if (confirmRemove.path) {
      removeRecentWorkspace(confirmRemove.path);
      reload();
    }
    setConfirmRemove({ isOpen: false, path: null, name: "" });
  };

  if (!isOpen) return null;

  const renderItem = (w) => {
    const isCurrent = w.path === currentWorkspace;
    return (
      <div
        key={w.path}
        onClick={() => { vibrate(); onSelect?.(w.path); }}
        className={`group w-full rounded-brand p-2.5 flex items-center gap-2.5 cursor-pointer transition-all duration-150 ${
          isCurrent ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
      >
        <Folder size={18} className="text-orange-500/70 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-text text-sm font-medium truncate">
            {w.name || getBasename(w.path)}
          </div>
          <div className="text-text-muted text-xs truncate">{shortPath(w.path)}</div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => handlePin(e, w.path)}
            className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-3 rounded-brand transition-colors"
            title={w.pinned ? "Unpin" : "Pin"}
          >
            {w.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button
            onClick={(e) => handleRename(e, w)}
            className="p-1.5 text-text-muted hover:text-text hover:bg-surface-3 rounded-brand transition-colors"
            title="Rename"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={(e) => handleRemoveClick(e, w)}
            className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-3 rounded-brand transition-colors"
            title="Remove"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
        <div
          className="card-elev w-[480px] max-w-[90vw] absolute top-20 left-1/2 -translate-x-1/2 flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header / Search */}
          <div className="px-3 py-2.5 flex items-center gap-2 border-b border-border">
            <Search size={16} className="text-text-muted flex-shrink-0" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces"
              className="flex-1 bg-transparent text-text text-sm outline-none placeholder:text-text-subtle"
            />
            <button
              onClick={() => { vibrate(); onClose?.(); }}
              className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-auto p-2">
            {pinned.length === 0 && others.length === 0 ? (
              <div className="px-3 py-6 text-center text-text-muted text-sm italic">
                No workspaces found
              </div>
            ) : (
              <>
                {pinned.length > 0 && (
                  <div className="mb-2">
                    <div className="px-2 py-1 text-text-subtle text-xs font-semibold uppercase tracking-wider">
                      Pinned
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {pinned.map(renderItem)}
                    </div>
                  </div>
                )}
                {others.length > 0 && (
                  <div>
                    <div className="px-2 py-1 text-text-subtle text-xs font-semibold uppercase tracking-wider">
                      Recent
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {others.map(renderItem)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-3 py-2.5 border-t border-border">
            <button
              onClick={() => { vibrate(); onOpenBrowse?.(); }}
              className="w-full flex items-center justify-center gap-2 bg-surface-2 hover:bg-surface-3 text-text px-3 py-2 rounded-brand text-sm font-medium transition-all duration-150 active:scale-[0.99]"
            >
              <FolderOpen size={16} />
              Open Folder...
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmRemove.isOpen}
        onClose={() => setConfirmRemove({ isOpen: false, path: null, name: "" })}
        onConfirm={confirmRemoveAction}
        title="Remove workspace"
        message={`Remove "${confirmRemove.name}" from recent workspaces?`}
      />
    </>
  );
}
