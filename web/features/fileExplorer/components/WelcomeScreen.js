"use client";

import { Folder, FolderOpen, Pin } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function formatTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / MINUTE_MS);
  const h = Math.floor(diff / HOUR_MS);
  const d = Math.floor(diff / DAY_MS);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

const getBasename = (p) => p?.split("/").filter(Boolean).pop() || p || "";
const shortPath = (p) => p?.replace(/^\/Users\/[^/]+/, "~") || "";

export default function WelcomeScreen({ recentWorkspaces = [], onSelectWorkspace, onOpenFolder }) {
  const pinned = recentWorkspaces.filter(w => w.pinned);
  const others = recentWorkspaces.filter(w => !w.pinned);
  const sorted = [...pinned, ...others];

  return (
    <div className="h-full w-full bg-bg flex items-center justify-center overflow-auto">
      <div className="w-full max-w-2xl px-8 py-16 flex flex-col items-center">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-text text-4xl font-semibold mb-3">Welcome to 9Remote</h1>
          <p className="text-text-muted text-base">Open a folder to get started</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 mb-12">
          <button
            onClick={() => { vibrate(); onOpenFolder?.(); }}
            className="bg-brand-500 hover:bg-brand-600 text-white px-5 py-2.5 rounded-brand font-medium flex items-center gap-2 transition-all duration-150 ease-out active:scale-[0.98]"
          >
            <FolderOpen size={18} />
            Open Folder
          </button>
        </div>

        {/* Recent */}
        <div className="w-full">
          <h2 className="text-text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
            Recent Workspaces
          </h2>
          {sorted.length === 0 ? (
            <p className="text-text-muted text-sm italic">No recent workspaces</p>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {sorted.map((w) => (
                <button
                  key={w.path}
                  onClick={() => { vibrate(); onSelectWorkspace?.(w.path); }}
                  className="w-full bg-surface hover:bg-surface-2 rounded-brand-lg p-3 flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] text-left"
                >
                  <Folder size={20} className="text-orange-500/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-text font-medium truncate" title={w.name || getBasename(w.path)}>
                        {w.name || getBasename(w.path)}
                      </span>
                      {w.pinned && <Pin size={12} className="text-brand-500 flex-shrink-0" />}
                    </div>
                    <div className="text-text-muted text-xs truncate" title={w.path}>{shortPath(w.path)}</div>
                  </div>
                  <div className="text-text-subtle text-xs flex-shrink-0">
                    {formatTime(w.lastOpened)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
