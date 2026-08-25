"use client";

import { useState, useEffect, useRef } from "react";
import Icon, { X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { isDiffPath, parseDiffPath } from "../constants/fileExplorer.js";
import { resolveFileIcon } from "../constants/fileIcons.js";

function pathToFileObj(filePath) {
  const name = filePath.split("/").pop() || filePath;
  return { name, type: "file", path: filePath };
}

export default function EditorTabs({ openedFiles, activeFile, dirtyFiles, onActivate, onClose, onCloseOthers, onCloseAll }) {
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menu]);

  if (!openedFiles?.length) return null;

  const handleContextMenu = (e, path) => {
    e.preventDefault();
    setMenu({ path, x: e.clientX, y: e.clientY });
  };

  const handleMouseDown = (e, path) => {
    if (e.button === 1) {
      e.preventDefault();
      vibrate();
      onClose(path);
    }
  };

  return (
    <div className="flex overflow-x-auto bg-surface border-b border-border flex-shrink-0 relative">
      {openedFiles.map((path) => {
        const isActive = path === activeFile;
        const isDirty = dirtyFiles?.has(path);
        const diff = isDiffPath(path);
        const realPath = diff ? parseDiffPath(path).absPath : path;
        const fileName = diff ? `${realPath.split("/").pop()} (diff)` : realPath.split("/").pop();
        const fileIcon = diff ? null : resolveFileIcon(pathToFileObj(realPath), 14);
        return (
          <div
            key={path}
            onClick={() => { vibrate(); onActivate(path); }}
            onMouseDown={(e) => handleMouseDown(e, path)}
            onContextMenu={(e) => handleContextMenu(e, path)}
            className={`group flex items-center gap-2 px-3 py-1.5 border-r border-border cursor-pointer text-sm flex-shrink-0 select-none ${
              isActive
                ? "bg-bg text-text border-t-2 border-t-brand-500"
                : "bg-surface text-text-muted hover:text-text"
            }`}
          >
            {fileIcon ? <span className="flex-shrink-0 flex items-center">{fileIcon}</span> : <Icon name="File" size={14} className="text-text-muted" />}
            <span className="truncate max-w-[160px]" title={realPath}>{fileName}</span>
            {isDirty ? (
              <span className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" />
            ) : null}
            <button
              onClick={(e) => {
                e.stopPropagation();
                vibrate();
                onClose(path);
              }}
              className={`p-0.5 rounded hover:bg-surface-3 transition-opacity ${
                isActive || isDirty ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {menu && (
        <div
          ref={menuRef}
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 bg-surface-2 border border-border rounded-brand shadow-lg py-1 text-sm min-w-[160px]"
        >
          {[
            { label: "Close", action: () => onClose(menu.path) },
            { label: "Close Others", action: () => onCloseOthers(menu.path) },
            { label: "Close All", action: () => onCloseAll() }
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => { vibrate(); item.action(); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-text hover:bg-surface-3 transition-colors"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
